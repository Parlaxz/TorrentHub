import { Writable } from "node:stream";
import { AuthController } from "../../src/main/auth/index.js";
import { buildRelayServer } from "../../src/main/relay/http/app.js";
import { jobNotFound, type JobService } from "../../src/main/relay/jobService.js";
import type { RelayAppDeps } from "../../src/main/relay/http/app.js";
import {
  initialStageMap,
  type IntakeDraftView,
  type JobRecord,
} from "../../src/main/jobs/types.js";

export function makeJobRecord(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    state: "queued",
    source: { kind: "magnet", value: "magnet:?xt=urn:btih:abcdef" },
    idempotencyKey: null,
    metadata: null,
    selection: null,
    selectedBytes: null,
    zipRequired: null,
    stages: initialStageMap(),
    telemetry: null,
    storage: null,
    hint: null,
    result: null,
    error: null,
    lastKnownStage: null,
    sessionEpoch: null,
    jobDir: null,
    downloadDir: null,
    packageDir: null,
    zipPath: null,
    directSourcePath: null,
    ...overrides,
  };
}

export class FakeJobService implements JobService {
  readonly calls: Array<{ method: string; args: unknown }> = [];
  private readonly intakes = new Map<string, IntakeDraftView>();
  private readonly jobs = new Map<string, JobRecord>();
  private seq = 0;

  async createIntake(input: Parameters<JobService["createIntake"]>[0]) {
    this.calls.push({ method: "createIntake", args: input });
    const id = `intake_${++this.seq}`;
    const view: IntakeDraftView = { id, state: "reading_metadata", metadata: null, error: null };
    this.intakes.set(id, view);
    return view;
  }

  async getIntake(id: string) {
    this.calls.push({ method: "getIntake", args: id });
    return this.intakes.get(id) ?? null;
  }

  async createJob(input: Parameters<JobService["createJob"]>[0]) {
    this.calls.push({ method: "createJob", args: input });
    const rec = makeJobRecord(`job_${++this.seq}`, {
      idempotencyKey: input.idempotencyKey ?? null,
    });
    this.jobs.set(rec.id, rec);
    return rec;
  }

  async listJobs() {
    this.calls.push({ method: "listJobs", args: null });
    return [...this.jobs.values()];
  }

  async getJob(id: string) {
    this.calls.push({ method: "getJob", args: id });
    return this.jobs.get(id) ?? null;
  }

  private async action(method: string, id: string, mutate?: (rec: JobRecord) => void) {
    this.calls.push({ method, args: id });
    const rec = this.jobs.get(id);
    if (!rec) throw jobNotFound(id);
    mutate?.(rec);
    rec.updatedAt = new Date().toISOString();
    return rec;
  }

  cancelJob(id: string) {
    return this.action("cancelJob", id, (rec) => {
      rec.state = "cancelled";
    });
  }

  retryPackaging(id: string) {
    return this.action("retryPackaging", id, (rec) => {
      rec.state = "packaging";
    });
  }

  retryUpload(id: string) {
    return this.action("retryUpload", id, (rec) => {
      rec.state = "uploading";
    });
  }

  recheckStorage(id: string) {
    return this.action("recheckStorage", id);
  }

  async listHistory(limit?: number) {
    this.calls.push({ method: "listHistory", args: limit ?? null });
    return [...this.jobs.values()].slice(0, limit ?? Infinity);
  }
}

export interface TestAppOptions {
  auth?: AuthController;
  jobs?: JobService;
  transportSnapshot?: RelayAppDeps["transportSnapshot"];
  bodyLimit?: number;
  captureLogs?: boolean;
}

export interface TestAppResult {
  app: ReturnType<typeof buildRelayServer>;
  auth: AuthController;
  jobs: FakeJobService;
  logs: string[];
}

export async function buildTestApp(options: TestAppOptions = {}): Promise<TestAppResult> {
  const auth = options.auth ?? new AuthController();
  const jobs = options.jobs ?? new FakeJobService();
  const logs: string[] = [];
  const logger = options.captureLogs
    ? {
        level: "info",
        stream: new Writable({
          write(chunk: unknown, _enc: unknown, cb: (err?: Error | null) => void) {
            logs.push(String(chunk));
            cb();
          },
        }),
      }
    : { level: "silent" };
  const app = buildRelayServer({
    auth,
    jobs,
    transportSnapshot: options.transportSnapshot,
    bodyLimit: options.bodyLimit,
    logger,
  });
  await app.ready();
  return { app, auth, jobs: jobs as FakeJobService, logs };
}

export async function pairClient(
  app: TestAppResult["app"],
  auth: AuthController,
  name = "tester",
): Promise<string> {
  const { code } = auth.beginPairing();
  const res = await app.inject({ method: "POST", url: "/v1/pair", payload: { code, name } });
  if (res.statusCode !== 200) {
    throw new Error(`pairClient failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { token: string }).token;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
