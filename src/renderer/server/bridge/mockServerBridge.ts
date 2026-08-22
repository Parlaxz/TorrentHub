/**
 * In-memory mock of `VikingRelayServerBridge`.
 *
 * Used by component tests and by `?demo=1` dev preview so the UI can be built
 * before preload/main land. Mirrors the real contract exactly — screens must
 * not be able to tell the difference.
 */

import type {
  AppSettings,
  HealthSnapshot,
  HistoryEntry,
  PairedClientInfo,
  PairingInfo,
  QbitProbeResult,
  RadminInterfaceInfo,
  RadminStatus,
  SentDirectJob,
  ServerCapabilities,
  TransferSnapshot,
  Unsubscribe,
  VikingConfigView,
  WorkingFolderStatus,
} from "./types";
import type { VikingRelayServerBridge } from "./types";

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  const group = () => `${pick()}${pick()}${pick()}${pick()}`;
  return `${group()}-${group()}`;
}

const DEFAULT_CAPABILITIES: ServerCapabilities = {
  chooseWorkingFolderDialog: true,
  testViking: true,
  startWithWindows: true,
  powerSaveBlocker: true,
  dismissInterruptedJob: true,
  cleanJobData: true,
  openQBittorrentWebUi: true,
  closeToTray: true,
  revealSecrets: false,
};

export interface MockScenario {
  online?: boolean;
  address?: string | null;
  radmin?: Pick<RadminStatus, "detected" | "connected" | "problem"> & {
    candidates?: RadminInterfaceInfo[];
  };
  qbitProbe?: QbitProbeResult;
  viking?: Partial<VikingConfigView>;
  driveTotalBytes?: number;
  driveFreeBytes?: number;
  job?: TransferSnapshot | null;
  history?: HistoryEntry[];
  capabilities?: Partial<ServerCapabilities>;
  pairingTtlSeconds?: number;
}

type Listener<T> = (value: T) => void;

function emitter<T>(): {
  emit(value: T): void;
  subscribe(cb: Listener<T>): Unsubscribe;
} {
  const listeners = new Set<Listener<T>>();
  return {
    emit(value) {
      listeners.forEach((cb) => cb(value));
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export class MockServerBridge implements VikingRelayServerBridge {
  private health: HealthSnapshot;
  private settings: AppSettings;
  private job: TransferSnapshot | null;
  private history: HistoryEntry[];
  private capabilitiesValue: ServerCapabilities;
  private pairing: PairingInfo | null = null;
  private qbitKeyStored = false;
  private vikingHashStored = false;
  private readonly probeResult: QbitProbeResult;
  private readonly radminScenario: MockScenario["radmin"];
  private readonly vikingScenario: Partial<VikingConfigView> | undefined;

  private readonly healthBus = emitter<HealthSnapshot>();
  private readonly jobBus = emitter<TransferSnapshot | null>();
  private readonly pairingBus = emitter<PairingInfo | null>();

  public readonly ttlSeconds: number;

  constructor(scenario: MockScenario = {}) {
    const freeBytes = scenario.driveFreeBytes ?? 1_556_444_672_000; // ~1.42 TB
    this.ttlSeconds = scenario.pairingTtlSeconds ?? 600;
    this.probeResult =
      scenario.qbitProbe ?? { ok: true, version: "5.2.1", supported: true };
    this.radminScenario = scenario.radmin;
    this.vikingScenario = scenario.viking;
    const radminOk =
      !scenario.radmin || (scenario.radmin.detected !== false && scenario.radmin.connected !== false);
    this.health = {
      online: scenario.online ?? true,
      address: (scenario.address !== undefined ? scenario.address : "26.14.203.87:47821") ?? null,
      radmin: radminOk
        ? { state: "ok", detail: "Connected" }
        : { state: "error", detail: scenario.radmin?.problem ?? "disconnected" },
      qbit: this.probeResult.ok
        ? { state: "ok", version: this.probeResult.version ?? null }
        : {
            state: "error",
            detail: this.probeResult.message ?? "qBittorrent not reachable",
          },
      viking:
        scenario.viking?.mode === "unconfigured"
          ? { state: "warn", detail: "Not configured" }
          : { state: "ok", detail: "Ready" },
      storage: { freeBytes, warning: "none" },
    };
    this.settings = {
      workingFolderPath: "D:\\VikingRelay",
      radminInterfaceId: null,
      relayPort: 47821,
      qbitWebUiUrl: "http://127.0.0.1:8080",
      qbitApiKeySet: false,
      vikingUserHashSet: false,
      startWithWindows: false,
      preventSleepDuringTransfers: true,
      cleanupDeleteTorrent: true,
      cleanupDeleteFiles: true,
      cleanupDeleteZip: true,
    };
    this.job = scenario.job !== undefined ? scenario.job : null;
    this.history = scenario.history ?? [];
    this.capabilitiesValue = { ...DEFAULT_CAPABILITIES, ...scenario.capabilities };
  }

  /* ------------------------------- setup + health ------------------------------ */

  async getWorkingFolderStatus(): Promise<WorkingFolderStatus> {
    return {
      path: this.settings.workingFolderPath,
      drive: this.settings.workingFolderPath
        ? {
            root: "D:",
            label: "Data",
            kind: "fixed",
            totalBytes: 2_000_398_934_016,
            freeBytes: this.health.storage.freeBytes ?? 0,
          }
        : null,
      writable: !!this.settings.workingFolderPath,
      error: null,
    };
  }

  async setWorkingFolderPath(path: string): Promise<WorkingFolderStatus> {
    const trimmed = path.trim();
    this.settings.workingFolderPath = trimmed.length > 0 ? trimmed : null;
    return this.getWorkingFolderStatus();
  }

  async chooseWorkingFolder(): Promise<WorkingFolderStatus> {
    this.settings.workingFolderPath = "D:\\VikingRelay";
    return this.getWorkingFolderStatus();
  }

  async getRadminStatus(): Promise<RadminStatus> {
    const connected = this.health.radmin.state === "ok";
    const candidates = this.radminScenario?.candidates ?? [];
    return {
      detected: this.radminScenario ? this.radminScenario.detected !== false : connected,
      connected,
      adapterName: connected ? "Radmin VPN" : null,
      ipv4: connected ? "26.14.203.87" : null,
      ambiguous: !connected && candidates.length > 1,
      candidates,
      selectedId: this.settings.radminInterfaceId,
      problem: connected
        ? null
        : (this.radminScenario?.problem ?? "disconnected"),
    };
  }

  async selectRadminInterface(id: string): Promise<RadminStatus> {
    this.settings.radminInterfaceId = id;
    // Selecting a pinned interface resolves ambiguity and connects.
    if (this.radminScenario) {
      this.radminScenario.detected = true;
      this.radminScenario.connected = true;
      this.radminScenario.problem = undefined;
    }
    this.emitHealth({ radmin: { state: "ok", detail: "Connected" } });
    return this.getRadminStatus();
  }

  async probeQbittorrent(config: { webUiUrl: string; apiKey?: string }): Promise<QbitProbeResult> {
    if (!/^https?:\/\/.+/.test(config.webUiUrl)) {
      return { ok: false, reason: "invalid_url", message: "That doesn't look like a valid URL." };
    }
    return this.probeResult;
  }

  async getVikingConfig(): Promise<VikingConfigView> {
    const base: VikingConfigView = {
      mode: this.vikingHashStored ? "user_hash" : "anonymous",
      supportsAnonymous: true,
      requiresUserHash: false,
      userHashMasked: this.vikingHashStored ? "a1b2\u20269f" : null,
    };
    return { ...base, ...this.vikingScenario };
  }

  async setVikingUserHash(hash: string): Promise<VikingConfigView> {
    this.vikingHashStored = hash.length > 0;
    return this.getVikingConfig();
  }

  async testViking(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "Viking credentials accepted." };
  }

  /* ---------------------------------- lifecycle -------------------------------- */

  async startServer(): Promise<HealthSnapshot> {
    this.health = { ...this.health, online: true };
    this.healthBus.emit(this.health);
    return this.health;
  }

  async stopServer(): Promise<void> {
    this.health = { ...this.health, online: false };
    this.healthBus.emit(this.health);
  }

  async getHealth(): Promise<HealthSnapshot> {
    return this.health;
  }

  /* ---------------------------------- pairing ---------------------------------- */

  async generatePairingCode(): Promise<PairingInfo> {
    this.pairing = {
      code: randomCode(),
      expiresAtEpochMs: Date.now() + this.ttlSeconds * 1000,
      ttlSeconds: this.ttlSeconds,
    };
    this.pairingBus.emit(this.pairing);
    return this.pairing;
  }

  async listPairedClients(): Promise<PairedClientInfo[]> {
    return [];
  }

  async revokePairedClient(_clientId: string): Promise<{ removed: boolean }> {
    return { removed: false };
  }

  async sendDirectJob(_source: string, _targetClientId: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async listDirectJobs(): Promise<SentDirectJob[]> {
    return [];
  }

  async resetProfile(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  /* ------------------------------------ jobs ----------------------------------- */

  async getActiveJob(): Promise<TransferSnapshot | null> {
    return this.job;
  }

  async getHistory(limit: number): Promise<HistoryEntry[]> {
    return this.history.slice(0, limit);
  }

  async getArchivedHistory(_limit: number): Promise<HistoryEntry[]> {
    return [];
  }

  async setJobArchived(_jobId: string, _archived: boolean): Promise<void> {}

  async copyText(text: string): Promise<boolean> {
    return text.length > 0;
  }

  async dismissInterruptedJob(jobId: string): Promise<void> {
    this.history = this.history.filter((h) => h.id !== jobId);
  }

  async cleanJobData(jobId: string): Promise<void> {
    this.history = this.history.filter((h) => h.id !== jobId);
  }

  async openQBittorrentWebUi(): Promise<void> {}

  /* ----------------------------- settings + secrets ---------------------------- */

  async getSettings(): Promise<AppSettings> {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  async setQbitApiKey(apiKey: string): Promise<{ ok: boolean }> {
    this.qbitKeyStored = apiKey.length > 0;
    this.settings.qbitApiKeySet = this.qbitKeyStored;
    return { ok: true };
  }

  async setVikingUserHashSetting(hash: string): Promise<{ ok: boolean }> {
    this.vikingHashStored = hash.length > 0;
    this.settings.vikingUserHashSet = this.vikingHashStored;
    return { ok: true };
  }

  /* --------------------------- capabilities + events --------------------------- */

  async capabilities(): Promise<ServerCapabilities> {
    return { ...this.capabilitiesValue };
  }

  async requestAppExit(): Promise<void> {}

  onHealth(cb: Listener<HealthSnapshot>): Unsubscribe {
    return this.healthBus.subscribe(cb);
  }

  onJob(cb: Listener<TransferSnapshot | null>): Unsubscribe {
    return this.jobBus.subscribe(cb);
  }

  onPairing(cb: Listener<PairingInfo | null>): Unsubscribe {
    return this.pairingBus.subscribe(cb);
  }

  /* ------------------------------- test helpers -------------------------------- */

  /** Push new snapshots as if main emitted them. */
  emitHealth(snapshot: Partial<HealthSnapshot>): void {
    this.health = { ...this.health, ...snapshot };
    this.healthBus.emit(this.health);
  }

  emitJob(job: TransferSnapshot | null): void {
    this.job = job;
    this.jobBus.emit(job);
  }
}
