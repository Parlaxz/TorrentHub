/**
 * ServerController — the real implementation behind A8's
 * `window.vikingRelayServer` bridge.
 *
 * Owns the Server Mode composition: setup (working folder, Radmin selection,
 * qBittorrent/Viking configuration), relay lifecycle, pairing, job/history
 * views, settings/secrets, health+job event push, and power management.
 *
 * Security rules honored here:
 *  - secrets are write-only for the renderer (no reveal capability);
 *  - external URLs are validated to http(s) before shell.openExternal;
 *  - Radmin binding never falls back to 0.0.0.0 or non-selected adapters;
 *  - destructive cleanup goes through the engine's guarded paths only.
 */
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app, clipboard, dialog, powerSaveBlocker, shell } from 'electron';

import type {
  AppSettings as ServerSettingsView,
  DriveInfo,
  HealthSnapshot,
  HistoryEntry,
  PairedClientInfo,
  PairingInfo,
  QbitProbeResult,
  RadminInterfaceInfo,
  RadminStatus,
  ServerCapabilities,
  SettingsPatch,
  SimpleHealthState,
  TransferSnapshot,
  VikingConfigView,
  VikingRelayServerBridge,
  WorkingFolderStatus,
} from '../../renderer/server/bridge/types';
import { isTerminalJobState } from '../jobs';
import type { JobRecord } from '../jobs/types';
import {
  QbitAuthError,
  QbitUnreachableError,
  QbitUnsupportedVersionError,
} from '../qbit/errors';
import { QbitTorrentService } from '../qbit/service';
import { collectIpv4Candidates, DEFAULT_RADMIN_ADAPTER_PATTERN } from '../relay/adapters';
import type { RelayManager } from '../relay/lifecycle';
import { getVolumeSpace } from '../storage';
import { VikingClient } from '../viking';
import { DEFAULT_SETTINGS } from '@shared/settings';
import {
  buildEngineGraph,
  buildQbitService,
  buildRelay,
  buildVikingClient,
  resolveJobsRoot,
  SECRET_QBIT_API_KEY,
  SECRET_VIKING_USER_HASH,
  type CompositionHost,
  type EngineGraph,
} from './composition';

const ACTIVE_JOB_POLL_MS = 1000;
const QBIT_PROBE_TTL_MS = 15_000;

/** Accepts bare "host:port" forms and defaults them to http:// (qBittorrent WebUI). */
function normalizeQbitBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export interface ServerControllerOptions {
  host: CompositionHost;
  /** Invoked when the renderer requests app exit (confirmation is the UI's job). */
  requestAppExit: () => void;
  /** "Friend mode" queue store (shared with the relay routes). */
  directJobs?: import('./direct-job-store').DirectJobStore | null;
}

export class ServerController implements VikingRelayServerBridge {
  readonly #host: CompositionHost;
  readonly #events = new EventEmitter();
  readonly #requestAppExit: () => void;
  readonly #directJobs: ServerControllerOptions['directJobs'];

  #graph: EngineGraph | null = null;
  #sweepDone = false;
  #relay: RelayManager | null = null;
  #pushTimer: NodeJS.Timeout | null = null;
  #powerBlockerId: number | null = null;
  #lastJob: TransferSnapshot | null = null;
  #qbitProbe: { at: number; result: HealthSnapshot['qbit'] } | null = null;

  constructor(options: ServerControllerOptions) {
    this.#host = options.host;
    this.#requestAppExit = options.requestAppExit;
    this.#directJobs = options.directJobs ?? null;
    this.#events.setMaxListeners(50);
  }

  /* ------------------------------------------------------------------ */
  /* setup + health                                                      */

  async getWorkingFolderStatus(): Promise<WorkingFolderStatus> {
    return workingFolderStatus(this.#host);
  }

  async setWorkingFolderPath(folderPath: string): Promise<WorkingFolderStatus> {
    const clean = String(folderPath ?? '').trim();
    if (!clean) {
      return { ...(await workingFolderStatus(this.#host)), error: 'path is empty' };
    }
    const previous = this.#host.settings.get().dataDir;
    this.#host.settings.update({ dataDir: clean });
    if (clean !== previous) {
      await this.#rebuildGraphForFolderChange();
    }
    return workingFolderStatus(this.#host);
  }

  async chooseWorkingFolder(): Promise<WorkingFolderStatus> {
    const result = await dialog.showOpenDialog({
      title: 'Choose Viking Relay working folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: this.#host.settings.get().dataDir ?? undefined,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return workingFolderStatus(this.#host);
    }
    return this.setWorkingFolderPath(result.filePaths[0]);
  }

  async getRadminStatus(): Promise<RadminStatus> {
    return radminStatus(this.#host.settings.get().radminInterfaceId ?? null);
  }

  async selectRadminInterface(id: string): Promise<RadminStatus> {
    const status = await radminStatus(null);
    const candidate = status.candidates?.find((c) => c.id === id);
    if (!candidate) {
      return { ...status, problem: 'unknown' };
    }
    this.#host.settings.update({ radminInterfaceId: candidate.ipv4 });
    const next = await radminStatus(candidate.ipv4);
    // Rebind the live transport when the address changed under a running relay.
    const snapshot = this.#relay?.snapshot();
    if (this.#relay && snapshot && snapshot.address !== candidate.ipv4) {
      try {
        await this.#relay.rebind({ address: candidate.ipv4 });
      } catch (error) {
        this.#host.log.warn({ err: error }, 'radmin rebind failed after selection');
      }
    }
    return next;
  }

  async probeQbittorrent(config: { webUiUrl: string; apiKey?: string }): Promise<QbitProbeResult> {
    const url = normalizeQbitBaseUrl(String(config.webUiUrl ?? ''));
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, reason: 'invalid_url', message: 'WebUI URL must be an http(s) URL' };
    }
    try {
      new URL(url);
    } catch {
      return { ok: false, reason: 'invalid_url', message: 'WebUI URL must be an http(s) URL' };
    }
    const apiKey = config.apiKey ?? this.#host.secrets.get(SECRET_QBIT_API_KEY) ?? undefined;
    const service = new QbitTorrentService({ baseUrl: url, apiKey });
    try {
      const caps = await service.healthCheck();
      this.#host.log.info({ url }, 'qBittorrent probe succeeded');
      return { ok: true, version: caps.qbtVersion, supported: true };
    } catch (error) {
      this.#host.log.warn(
        {
          err: error,
          url,
          keySource: config.apiKey ? 'request' : apiKey !== undefined ? 'stored' : 'none',
        },
        'qBittorrent probe failed',
      );
      if (error instanceof QbitUnreachableError) {
        return {
          ok: false,
          reason: 'not_running',
          message: 'qBittorrent is not reachable. Start qBittorrent and enable its WebUI.',
        };
      }
      if (error instanceof QbitAuthError) {
        return {
          ok: false,
          reason: 'auth',
          message: apiKey
            ? 'qBittorrent rejected the API key.'
            : 'No API key configured yet — create one in qBittorrent (Web UI settings) and paste it above.',
        };
      }
      if (error instanceof QbitUnsupportedVersionError) {
        return {
          ok: false,
          reason: 'version_too_old',
          message: 'qBittorrent 5.2 or newer is required.',
        };
      }
      return { ok: false, reason: 'unknown', message: describe(error) };
    }
  }

  async getVikingConfig(): Promise<VikingConfigView> {
    const hash = this.#host.secrets.get(SECRET_VIKING_USER_HASH);
    return {
      mode: hash ? 'user_hash' : 'unconfigured',
      supportsAnonymous: true,
      requiresUserHash: false,
      userHashMasked: hash ? maskSecret(hash) : null,
    };
  }

  async setVikingUserHash(hash: string): Promise<VikingConfigView> {
    const clean = String(hash ?? '').trim();
    if (clean.length === 0) {
      this.#host.secrets.delete(SECRET_VIKING_USER_HASH);
    } else {
      const ok = this.#host.secrets.set(SECRET_VIKING_USER_HASH, clean);
      if (!ok) {
        return { ...(await this.getVikingConfig()) };
      }
    }
    this.swapVikingClient();
    return this.getVikingConfig();
  }

  /* ------------------------------------------------------------------ */
  /* server lifecycle                                                    */

  async startServer(): Promise<HealthSnapshot> {
    const graph = this.ensureGraph();
    if (!this.#sweepDone) {
      const marked = await graph.engine.startupSweep();
      this.#sweepDone = true;
      if (marked > 0) {
        this.#host.log.info({ marked }, 'startup sweep marked interrupted jobs');
      }
    }

    this.#relay = buildRelay(this.#host, graph.jobService, graph.auth, this.#directJobs);
    await this.#relay.start();

    // The relay may have fallen back to a different adapter address (stale
    // pin); re-pin so the next start binds directly.
    const snap = this.#relay.snapshot();
    if (snap.state === 'listening' && snap.address) {
      const pinned = this.#host.settings.get().radminInterfaceId;
      if (pinned && pinned !== snap.address) {
        this.#host.settings.update({ radminInterfaceId: snap.address });
        this.#host.log.info(
          { from: pinned, to: snap.address },
          're-pinned radmin interface to actual address',
        );
      }
    }

    this.startPushLoop();
    return this.getHealth();
  }

  async stopServer(): Promise<void> {
    if (this.#relay) {
      try {
        await this.#relay.stop();
      } finally {
        this.#relay = null;
      }
    }
    return this.getHealth().then(() => undefined);
  }

  async getHealth(): Promise<HealthSnapshot> {
    const snapshot = this.#relay?.snapshot() ?? null;
    const online = snapshot?.state === 'listening';
    const address =
      online && snapshot?.address && snapshot.port
        ? `${snapshot.address}:${snapshot.port}`
        : null;

    let radminState: SimpleHealthState = 'unknown';
    let radminDetail: string | null = null;
    if (online) {
      radminState = 'ok';
      radminDetail = snapshot?.adapterName ?? null;
    } else if (snapshot?.state === 'unavailable') {
      radminState = 'error';
      radminDetail = snapshot.bindError ?? 'Radmin adapter unavailable';
    } else if (snapshot?.state === 'error') {
      radminState = 'error';
      radminDetail = snapshot.bindError ?? 'relay bind failed';
    } else if (snapshot?.state === 'stopped') {
      radminState = 'warn';
      radminDetail = 'server stopped';
    } else {
      radminState = 'unknown';
      radminDetail = 'server not started';
    }

    const qbit = await this.qbitHealth();
    const viking = await this.vikingHealth();
    const storage = await this.storageSummary();

    return {
      online,
      address,
      radmin: { state: radminState, detail: radminDetail },
      qbit,
      viking,
      storage,
    };
  }

  /* ------------------------------------------------------------------ */
  /* pairing                                                             */

  async generatePairingCode(): Promise<PairingInfo> {
    const auth = this.ensureGraph().auth;
    const issued = auth.beginPairing();
    const ttlSeconds = Math.max(1, Math.round((issued.expiresAt - Date.now()) / 1000));
    const info: PairingInfo = {
      code: issued.code,
      expiresAtEpochMs: issued.expiresAt,
      ttlSeconds,
    };
    this.#events.emit('pairing', info);
    return info;
  }

  /** Active (non-revoked) paired clients — pairing persists until revoked. */
  async listPairedClients(): Promise<PairedClientInfo[]> {
    return this.ensureGraph()
      .auth.listClients()
      .filter((c) => !c.revoked)
      .map(({ clientId, name, createdAt }) => ({ clientId, name, createdAt }));
  }

  /** Sends a link to a paired client's download queue ("friend mode"). */
  async sendDirectJob(
    source: string,
    targetClientId: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (!this.#directJobs) return { ok: false, error: 'direct jobs unavailable' };
    const value = String(source ?? '').trim();
    let kind: 'magnet' | 'url' | 'direct';
    if (value.startsWith('magnet:')) kind = 'magnet';
    else if (/^https?:\/\//i.test(value)) kind = 'url';
    else return { ok: false, error: 'enter a magnet or http(s) link' };

    const target = await this.listPairedClients();
    const client = target.find((c) => c.clientId === targetClientId);
    if (!client) return { ok: false, error: 'that client is no longer paired' };

    const job = await this.#directJobs.add(value, kind, client.clientId, client.name);
    this.#host.log.info({ jobId: job.id, target: client.name }, 'direct job sent');
    return { ok: true, id: job.id };
  }

  async listDirectJobs(): Promise<
    Array<{
      id: string;
      source: string;
      sourceKind: string;
      targetName: string;
      state: 'queued' | 'accepted' | 'declined';
      createdAt: string;
    }>
  > {
    if (!this.#directJobs) return [];
    return this.#directJobs.listAll();
  }

  async revokePairedClient(clientId: string): Promise<{ removed: boolean }> {
    const removed = this.ensureGraph().auth.revokeClient(String(clientId)) > 0;
    if (removed) {
      this.#host.log.info({ clientId }, 'paired client disconnected by server');
    }
    return { removed };
  }

  /* ------------------------------------------------------------------ */
  /* jobs                                                                */

  async getActiveJob(): Promise<TransferSnapshot | null> {
    return this.findActiveJob();
  }

  async getHistory(limit: number, archivedOnly = false): Promise<HistoryEntry[]> {
    const jobs = await this.allJobs();
    return jobs
      .filter((j) => isTerminalJobState(j.state))
      .filter((j) => (archivedOnly ? j.archived === true : j.archived !== true))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(toHistoryEntry);
  }

  async setJobArchived(jobId: string, archived: boolean): Promise<void> {
    await this.ensureGraph().engine.setArchived(jobId, archived);
  }

  async getArchivedHistory(limit: number): Promise<HistoryEntry[]> {
    return this.getHistory(limit, true);
  }

  async copyText(text: string): Promise<boolean> {
    clipboard.writeText(String(text ?? ''));
    return true;
  }

  async dismissInterruptedJob(jobId: string): Promise<void> {
    const repository = this.ensureGraph().repository;
    const record = await repository.get(jobId);
    if (!record || record.state !== 'interrupted') return;
    record.dismissed = true;
    await repository.upsert(record);
  }

  async cleanJobData(jobId: string): Promise<void> {
    await this.ensureGraph().engine.discardArtifacts(jobId);
  }

  async openQBittorrentWebUi(): Promise<void> {
    const url = this.#host.settings.get().qbittorrentBaseUrl;
    if (!/^https?:\/\//i.test(url)) throw new Error('invalid qBittorrent URL');
    await shell.openExternal(url);
  }

  /* ------------------------------------------------------------------ */
  /* settings + secrets                                                  */

  async getSettings(): Promise<ServerSettingsView> {
    return settingsView(this.#host);
  }

  async updateSettings(patch: SettingsPatch): Promise<ServerSettingsView> {
    const previousDataDir = this.#host.settings.get().dataDir;
    const mapped: Record<string, unknown> = {};
    if (patch.workingFolderPath !== undefined) mapped.dataDir = patch.workingFolderPath;
    if (patch.radminInterfaceId !== undefined) mapped.radminInterfaceId = patch.radminInterfaceId;
    if (patch.relayPort !== undefined) mapped.serverPort = patch.relayPort;
    if (patch.qbitWebUiUrl !== undefined) {
      mapped.qbittorrentBaseUrl = normalizeQbitBaseUrl(patch.qbitWebUiUrl);
    }
    if (patch.startWithWindows !== undefined) mapped.startWithWindows = patch.startWithWindows;
    if (patch.preventSleepDuringTransfers !== undefined) {
      mapped.preventSleepDuringTransfers = patch.preventSleepDuringTransfers;
    }
    if (patch.cleanupDeleteTorrent !== undefined) mapped.cleanupDeleteTorrent = patch.cleanupDeleteTorrent;
    if (patch.cleanupDeleteFiles !== undefined) mapped.cleanupDeleteFiles = patch.cleanupDeleteFiles;
    if (patch.cleanupDeleteZip !== undefined) mapped.cleanupDeleteZip = patch.cleanupDeleteZip;
    this.#host.settings.update(mapped);

    const next = this.#host.settings.get();
    applyLoginItem(next.startWithWindows);

    // A working-folder change invalidates the engine graph: jobsRoot, the
    // workspace gateway, and packaging paths were resolved against the OLD
    // folder. Rebuild so preflight checks the volume downloads actually use.
    if (
      patch.workingFolderPath !== undefined &&
      (patch.workingFolderPath ?? null) !== previousDataDir
    ) {
      await this.#rebuildGraphForFolderChange();
    }

    // Port/adapter changes require the transport to be rebuilt on next start.
    if (this.#relay && (patch.relayPort !== undefined || patch.radminInterfaceId !== undefined)) {
      this.#host.log.info('relay port/adapter changed; restart the server to apply');
    }
    return settingsView(this.#host);
  }

  /** Rebuilds the engine graph after a working-folder change (idle only). */
  async #rebuildGraphForFolderChange(): Promise<void> {
    if (this.hasActiveTransfer()) {
      this.#host.log.warn(
        'working folder change deferred until the active transfer finishes; storage checks still target the old folder',
      );
      return;
    }
    const wasRunning = this.#relay !== null;
    if (this.#relay) {
      try {
        await this.#relay.stop();
      } catch (error) {
        this.#host.log.warn({ err: error }, 'relay stop during folder change failed');
      } finally {
        this.#relay = null;
      }
    }
    this.stopPushLoop();
    this.#graph = null;
    this.#qbitProbe = null;
    this.#host.log.info({ dataDir: this.#host.settings.get().dataDir }, 'engine graph rebuilt for new working folder');
    if (wasRunning) {
      try {
        await this.startServer();
      } catch (error) {
        this.#host.log.error({ err: error }, 'server restart after folder change failed');
      }
    }
  }

  async setQbitApiKey(apiKey: string): Promise<{ ok: boolean }> {
    const clean = String(apiKey ?? '').trim();
    if (clean.length === 0) {
      return { ok: this.#host.secrets.delete(SECRET_QBIT_API_KEY) };
    }
    const ok = this.#host.secrets.set(SECRET_QBIT_API_KEY, clean);
    if (ok) this.swapQbitService();
    this.#qbitProbe = null;
    return { ok };
  }

  /**
   * Wipes the server profile: stops the relay, revokes every paired client,
   * deletes all server secrets and resets settings to first-run defaults.
   * Transfer history and downloaded data on disk are left untouched.
   */
  async resetProfile(): Promise<{ ok: boolean }> {
    this.stopPushLoop();
    if (this.#relay) {
      try {
        await this.#relay.stop();
      } catch (error) {
        this.#host.log.warn({ err: error }, 'relay stop during profile reset failed');
      } finally {
        this.#relay = null;
      }
    }
    const revoked = this.ensureGraph().auth.revokeAll();
    for (const key of [
      SECRET_QBIT_API_KEY,
      SECRET_VIKING_USER_HASH,
      'auth.tokenSecret',
      'auth.tokens',
    ]) {
      this.#host.secrets.delete(key);
    }
    this.#host.settings.update({
      mode: null,
      serverPort: DEFAULT_SETTINGS.serverPort,
      qbittorrentBaseUrl: DEFAULT_SETTINGS.qbittorrentBaseUrl,
      dataDir: null,
      radminInterfaceId: null,
      startWithWindows: false,
      preventSleepDuringTransfers: true,
    });
    applyLoginItem(false);
    this.#qbitService = null;
    this.#vikingClient = null;
    this.#qbitProbe = null;
    this.#host.log.info({ revoked }, 'server profile reset; returning to onboarding');
    return { ok: true };
  }

  async capabilities(): Promise<ServerCapabilities> {
    return {
      chooseWorkingFolderDialog: true,
      testViking: false, // no non-destructive validation exists in the Viking API
      startWithWindows: true,
      powerSaveBlocker: true,
      dismissInterruptedJob: true,
      cleanJobData: true,
      openQBittorrentWebUi: true,
      closeToTray: true,
      revealSecrets: false,
    };
  }

  async requestAppExit(): Promise<void> {
    this.#requestAppExit();
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */

  onHealth(cb: (snapshot: HealthSnapshot) => void): () => void {
    this.#events.on('health', cb);
    return () => this.#events.off('health', cb);
  }

  onJob(cb: (job: TransferSnapshot | null) => void): () => void {
    this.#events.on('job', cb);
    return () => this.#events.off('job', cb);
  }

  onPairing(cb: (pairing: PairingInfo | null) => void): () => void {
    this.#events.on('pairing', cb);
    return () => this.#events.off('pairing', cb);
  }

  /** True while a server-side transfer pipeline is running (tray/exit logic). */
  hasActiveTransfer(): boolean {
    return this.#lastJob !== null;
  }

  /** Pushes one health+job tick; used by both the timer and initial load. */
  async pushTick(): Promise<void> {
    try {
      const health = await this.getHealth();
      this.#events.emit('health', health);
    } catch (error) {
      this.#host.log.warn({ err: error }, 'health tick failed');
    }
    try {
      const job = await this.findActiveJob();
      this.#lastJob = job;
      this.#events.emit('job', job);
    } catch (error) {
      this.#host.log.warn({ err: error }, 'job tick failed');
    }
    this.updatePowerBlocker();
  }

  startPushLoop(): void {
    if (this.#pushTimer) return;
    void this.pushTick();
    this.#pushTimer = setInterval(() => void this.pushTick(), ACTIVE_JOB_POLL_MS);
    this.#pushTimer.unref?.();
  }

  stopPushLoop(): void {
    if (this.#pushTimer) {
      clearInterval(this.#pushTimer);
      this.#pushTimer = null;
    }
    this.releasePowerBlocker();
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */

  ensureGraph(): EngineGraph {
    if (this.#graph) return this.#graph;
    this.#graph = buildEngineGraph(
      this.#host,
      () => this.currentQbit(),
      () => this.currentViking(),
    );
    return this.#graph;
  }

  #qbitService: QbitTorrentService | null = null;
  currentQbit(): QbitTorrentService {
    if (!this.#qbitService) this.#qbitService = buildQbitService(this.#host);
    return this.#qbitService;
  }

  #vikingClient: VikingClient | null = null;
  currentViking(): VikingClient {
    if (!this.#vikingClient) this.#vikingClient = buildVikingClient(this.#host);
    return this.#vikingClient;
  }

  private swapQbitService(): void {
    if (this.hasActiveTransfer()) {
      this.#host.log.warn('qBittorrent config change deferred until the transfer finishes');
      return;
    }
    this.#qbitService = buildQbitService(this.#host);
    this.#qbitProbe = null;
  }

  private swapVikingClient(): void {
    if (this.hasActiveTransfer()) {
      this.#host.log.warn('Viking config change deferred until the transfer finishes');
      return;
    }
    this.#vikingClient = buildVikingClient(this.#host);
  }

  private async findActiveJob(): Promise<TransferSnapshot | null> {
    const jobs = await this.allJobs();
    const active = jobs.find(
      (j) => !isTerminalJobState(j.state) && j.dismissed !== true,
    );
    if (!active) return null;
    return toTransferSnapshot(active);
  }

  private allJobs(): Promise<JobRecord[]> {
    return this.ensureGraph().repository.loadAll();
  }

  private async qbitHealth(): Promise<HealthSnapshot['qbit']> {
    const cached = this.#qbitProbe;
    if (cached && Date.now() - cached.at < QBIT_PROBE_TTL_MS) return cached.result;
    let result: HealthSnapshot['qbit'];
    const service = this.currentQbit();
    try {
      const caps = await service.healthCheck();
      result = { state: 'ok', version: caps.qbtVersion, detail: null };
    } catch (error) {
      if (error instanceof QbitUnreachableError) {
        result = { state: 'error', version: null, detail: 'not running / WebUI unreachable' };
      } else if (error instanceof QbitAuthError) {
        result = { state: 'error', version: null, detail: 'authentication failed' };
      } else if (error instanceof QbitUnsupportedVersionError) {
        result = { state: 'error', version: null, detail: 'unsupported version (need >= 5.2)' };
      } else {
        result = { state: 'unknown', version: null, detail: describe(error) };
      }
    }
    this.#qbitProbe = { at: Date.now(), result };
    return result;
  }

  private async vikingHealth(): Promise<HealthSnapshot['viking']> {
    const hash = this.#host.secrets.get(SECRET_VIKING_USER_HASH);
    return {
      state: hash ? 'ok' : 'ok',
      detail: hash ? 'account uploads' : 'anonymous uploads',
    };
  }

  private async storageSummary(): Promise<HealthSnapshot['storage']> {
    try {
      const volume = await getVolumeSpace(resolveJobsRoot(this.#host));
      return { freeBytes: volume.freeBytes, warning: 'none' };
    } catch {
      return { freeBytes: null, warning: 'none' };
    }
  }

  private updatePowerBlocker(): void {
    const wanted =
      this.#lastJob !== null && this.#host.settings.get().preventSleepDuringTransfers;
    if (wanted && this.#powerBlockerId === null) {
      this.#powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      this.#host.log.info({ blocker: this.#powerBlockerId }, 'power save blocker started');
    } else if (!wanted && this.#powerBlockerId !== null) {
      this.releasePowerBlocker();
    }
  }

  private releasePowerBlocker(): void {
    if (this.#powerBlockerId !== null) {
      try {
        powerSaveBlocker.stop(this.#powerBlockerId);
      } finally {
        this.#host.log.info({ blocker: this.#powerBlockerId }, 'power save blocker released');
        this.#powerBlockerId = null;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* module-level helpers                                                */

async function workingFolderStatus(host: CompositionHost): Promise<WorkingFolderStatus> {
  const settings = host.settings.get();
  const folderPath = settings.dataDir;
  if (!folderPath) {
    return { path: null, drive: null, writable: false, error: null };
  }
  try {
    await mkdir(folderPath, { recursive: true });
    const probe = path.join(folderPath, `.vr-write-test-${process.pid}`);
    await writeFile(probe, 'probe');
    await unlink(probe);
    const volume = await getVolumeSpace(folderPath);
    const drive: DriveInfo = {
      root: path.parse(folderPath).root || folderPath,
      label: null,
      kind: 'unknown',
      totalBytes: volume.totalBytes,
      freeBytes: volume.freeBytes,
    };
    return { path: folderPath, drive, writable: true, error: null };
  } catch (error) {
    return { path: folderPath, drive: null, writable: false, error: describe(error) };
  }
}

async function radminStatus(selectedAddress: string | null): Promise<RadminStatus> {
  const candidates: RadminInterfaceInfo[] = collectIpv4Candidates(
    os.networkInterfaces() as unknown as Record<string, never>,
  ).map((c) => ({ id: c.address, name: c.adapterName, ipv4: c.address }));
  const radminNamed = candidates.filter((c) => DEFAULT_RADMIN_ADAPTER_PATTERN.test(c.name));

  const detected = radminNamed.length > 0;
  const pool = detected ? radminNamed : candidates;

  const selected = selectedAddress
    ? pool.find((c) => c.ipv4 === selectedAddress) ?? null
    : null;
  const autoSelected = !selected && pool.length > 0 ? pool[0] : null;
  const connected = Boolean(selected ?? autoSelected);
  const ambiguous = !selected && pool.length > 1;

  let problem: RadminStatus['problem'] = null;
  if (selectedAddress && !selected) problem = 'unknown';
  else if (pool.length === 0) problem = 'not_installed';
  else if (!connected && detected) problem = 'disconnected';
  else if (ambiguous) problem = 'ambiguous';

  return {
    detected,
    connected,
    adapterName: (selected ?? autoSelected)?.name ?? null,
    ipv4: (selected ?? autoSelected)?.ipv4 ?? null,
    ambiguous,
    candidates: pool,
    selectedId: selected?.id ?? null,
    problem,
  };
}

function settingsView(host: CompositionHost): ServerSettingsView {
  const s = host.settings.get();
  return {
    workingFolderPath: s.dataDir,
    radminInterfaceId: s.radminInterfaceId,
    relayPort: s.serverPort,
    qbitWebUiUrl: s.qbittorrentBaseUrl,
    qbitApiKeySet: host.secrets.get(SECRET_QBIT_API_KEY) !== null,
    vikingUserHashSet: host.secrets.get(SECRET_VIKING_USER_HASH) !== null,
    startWithWindows: s.startWithWindows,
    preventSleepDuringTransfers: s.preventSleepDuringTransfers,
    cleanupDeleteTorrent: s.cleanupDeleteTorrent,
    cleanupDeleteFiles: s.cleanupDeleteFiles,
    cleanupDeleteZip: s.cleanupDeleteZip,
  };
}

function applyLoginItem(open: boolean): void {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: open,
    args: ['--hidden'],
  });
}

function toTransferSnapshot(record: JobRecord): TransferSnapshot {
  return {
    id: record.id,
    name: record.metadata?.name ?? record.source.value,
    state: record.state,
    zipRequired: record.zipRequired === true,
    telemetry: record.telemetry ?? null,
    storage: record.storage ?? null,
    error: record.error?.message ?? null,
  };
}

function toHistoryEntry(record: JobRecord): HistoryEntry {
  return {
    id: record.id,
    name: record.metadata?.name ?? record.source.value,
    finalState: record.state as HistoryEntry["finalState"],
    url: record.result?.url ?? null,
    finishedAt: record.updatedAt,
    errorKind: record.error?.kind ?? null,
    errorMessage: record.error?.message ?? null,
    archived: record.archived === true,
  };
}

function maskSecret(value: string): string {
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
