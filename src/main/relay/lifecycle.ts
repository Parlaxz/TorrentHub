import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import {
  defaultEnumerateInterfaces,
  selectAdapter,
  type AdapterCandidate,
  type AdapterSelection,
  type EnumerateInterfaces,
  type SelectionConfig,
} from "./adapters.js";

export type RelayTransportState =
  | "stopped"
  | "starting"
  | "listening"
  | "unavailable"
  | "error";

export interface RelaySnapshot {
  state: RelayTransportState;
  host: string | null;
  port: number | null;
  adapterName: string | null;
  address: string | null;
  bindError: string | null;
  candidates: AdapterCandidate[];
  updatedAt: string;
}

export interface RelayManagerOptions {
  port?: number;
  enumerate?: EnumerateInterfaces;
  selection?: SelectionConfig;
  buildApp: () => FastifyInstance | Promise<FastifyInstance>;
  pollIntervalMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export const DEFAULT_RELAY_PORT = 47821;

export type WatchDecision =
  | { action: "keep" }
  | { action: "shutdown"; cause: "adapter_lost" }
  | {
      action: "rebind";
      address: string;
      cause: "adapter_address_changed" | "adapter_returned";
    };

export function planWatchTick(
  prev: { state: RelayTransportState; adapterName: string | null; address: string | null },
  scan: AdapterSelection,
): WatchDecision {
  if (!prev.adapterName || !prev.address) return { action: "keep" };
  const sameAdapter = scan.candidates.filter((c) => c.adapterName === prev.adapterName);
  if (sameAdapter.length === 0) {
    return prev.state === "listening" || prev.state === "error"
      ? { action: "shutdown", cause: "adapter_lost" }
      : { action: "keep" };
  }
  const exact = sameAdapter.find((c) => c.address === prev.address);

  if (prev.state === "listening") {
    if (exact) return { action: "keep" };
    return {
      action: "rebind",
      address: sameAdapter[0].address,
      cause: "adapter_address_changed",
    };
  }

  if (prev.state === "unavailable" || prev.state === "error") {
    return {
      action: "rebind",
      address: exact ? exact.address : sameAdapter[0].address,
      cause: "adapter_returned",
    };
  }

  return { action: "keep" };
}

function parsePortFromEnv(): number | null {
  const raw = process.env.RELAY_PORT;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

type SnapshotPatch = Partial<
  Pick<
    RelaySnapshot,
    "state" | "host" | "port" | "adapterName" | "address" | "bindError" | "candidates"
  >
>;

export class RelayManager {
  private state: RelayTransportState = "stopped";
  private host: string | null = null;
  private port: number | null = null;
  private adapterName: string | null = null;
  private address: string | null = null;
  private bindError: string | null = null;
  private candidates: AdapterCandidate[] = [];
  private app: FastifyInstance | null = null;
  private timer: NodeJS.Timeout | null = null;
  private selection: SelectionConfig;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly events = new EventEmitter();
  private readonly enumerate: EnumerateInterfaces;
  private readonly configuredPort: number;
  private readonly buildApp: () => FastifyInstance | Promise<FastifyInstance>;
  private readonly pollIntervalMs: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  constructor(options: RelayManagerOptions) {
    this.enumerate = options.enumerate ?? defaultEnumerateInterfaces;
    this.selection = options.selection ?? {};
    this.configuredPort = options.port ?? parsePortFromEnv() ?? DEFAULT_RELAY_PORT;
    this.buildApp = options.buildApp;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.logger = options.logger ?? console;
  }

  snapshot(): RelaySnapshot {
    return {
      state: this.state,
      host: this.host,
      port: this.port,
      adapterName: this.adapterName,
      address: this.address,
      bindError: this.bindError,
      candidates: this.candidates.map((c) => ({ ...c })),
      updatedAt: new Date().toISOString(),
    };
  }

  get fastify(): FastifyInstance | null {
    return this.app;
  }

  onChange(listener: (snapshot: RelaySnapshot) => void): () => void {
    this.events.on("change", listener);
    return () => {
      this.events.off("change", listener);
    };
  }

  async start(): Promise<RelaySnapshot> {
    return this.run(() => this.startLocked());
  }

  async stop(): Promise<RelaySnapshot> {
    return this.run(async () => {
      this.stopWatcher();
      await this.stopListenerLocked();
      this.adapterName = null;
      this.address = null;
      this.bindError = null;
      this.apply({
        state: "stopped",
        host: null,
        port: null,
        adapterName: null,
        address: null,
        bindError: null,
      });
      return this.snapshot();
    });
  }

  async rebind(options?: { address?: string | null }): Promise<RelaySnapshot> {
    return this.run(async () => {
      if (options && "address" in options) {
        this.selection = { ...this.selection, overrideAddress: options.address ?? undefined };
      }
      await this.stopListenerLocked();
      this.apply({ state: "stopped", bindError: null });
      return this.startLocked();
    });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private apply(patch: SnapshotPatch): void {
    if (patch.state !== undefined) this.state = patch.state;
    if ("host" in patch) this.host = patch.host ?? null;
    if ("port" in patch) this.port = patch.port ?? null;
    if ("adapterName" in patch) this.adapterName = patch.adapterName ?? null;
    if ("address" in patch) this.address = patch.address ?? null;
    if ("bindError" in patch) this.bindError = patch.bindError ?? null;
    if (patch.candidates !== undefined) this.candidates = patch.candidates;
    this.events.emit("change", this.snapshot());
  }

  private async startLocked(): Promise<RelaySnapshot> {
    if (this.state === "listening" || this.state === "starting") return this.snapshot();
    await this.stopListenerLocked();
    this.apply({ state: "starting", bindError: null });

    const scan = selectAdapter(this.enumerate(), this.selection);
    this.apply({ candidates: scan.candidates });

    if (!scan.selected) {
      const reason =
        scan.reason === "override_not_found"
          ? "override_address_not_found"
          : "radmin_adapter_not_detected";
      this.apply({
        state: "unavailable",
        host: null,
        port: null,
        adapterName: null,
        address: null,
        bindError: reason,
      });
      return this.snapshot();
    }

    if (scan.selected.address === "0.0.0.0") {
      this.logger.error("relay refused to bind 0.0.0.0");
      this.apply({
        state: "error",
        host: null,
        port: null,
        adapterName: null,
        address: null,
        bindError: "unsafe_bind_target",
      });
      return this.snapshot();
    }

    try {
      const app = await this.buildApp();
      await app.listen({ host: scan.selected.address, port: this.configuredPort });
      const bound = app.server.address();
      const boundPort =
        bound !== null && typeof bound === "object" ? bound.port : this.configuredPort;
      this.app = app;
      this.apply({
        state: "listening",
        host: scan.selected.address,
        port: boundPort,
        adapterName: scan.selected.adapterName,
        address: scan.selected.address,
        bindError: null,
      });
      this.startWatcher();
      this.logger.info(
        `relay listening on ${scan.selected.address}:${boundPort} (${scan.selected.adapterName})`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      this.logger.error(`relay bind failed on ${scan.selected.address}:${this.configuredPort}: ${code}`);
      this.apply({
        state: "error",
        host: null,
        port: null,
        bindError: `bind_failed:${code}`,
      });
    }
    return this.snapshot();
  }

  private startWatcher(): void {
    if (this.pollIntervalMs <= 0 || this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.run(() => this.watchTickLocked());
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  private stopWatcher(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async watchTickLocked(): Promise<void> {
    if (this.state === "stopped" || this.state === "starting") return;
    const prev = { state: this.state, adapterName: this.adapterName, address: this.address };
    const scan = selectAdapter(this.enumerate(), this.selection);
    this.apply({ candidates: scan.candidates });

    const decision = planWatchTick(prev, scan);
    if (decision.action === "keep") return;

    if (decision.action === "shutdown") {
      await this.stopListenerLocked();
      this.logger.warn(`radmin adapter lost (${prev.adapterName}); relay unavailable`);
      this.apply({
        state: "unavailable",
        host: null,
        port: null,
        bindError: "radmin_adapter_lost",
      });
      return;
    }

    this.logger.info(
      `rebinding relay to ${decision.address} (${decision.cause})`,
    );
    await this.stopListenerLocked();
    this.address = decision.address;
    await this.startLocked();
  }

  private async stopListenerLocked(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app !== null) {
      try {
        await app.close();
      } catch {
        this.app = null;
      }
    }
  }
}
