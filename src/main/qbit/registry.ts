/**
 * In-memory registries linking locally-minted intake tokens and Viking Relay
 * job ids to qBittorrent torrent identities.
 *
 * The WebAPI provides no server-side intake tokens, so tokens are minted here
 * (`vr_intake_<hash>`) and resolved against these registries. Registries are
 * intentionally volatile: a restart loses pending intakes (documented V1
 * limitation) but committed jobs remain verifiable through their qBittorrent
 * tags/categories alone.
 */

import type { IntakeRecord, IntakeToken, JobRecord } from './types';

export class IntakeRegistry {
  private readonly intakes = new Map<string, IntakeRecord>();
  private readonly jobs = new Map<string, JobRecord>();

  putIntake(record: IntakeRecord): void {
    this.intakes.set(record.token, record);
  }

  getIntake(token: IntakeToken): IntakeRecord | undefined {
    return this.intakes.get(token);
  }

  removeIntake(token: IntakeToken): boolean {
    return this.intakes.delete(token);
  }

  putJob(record: JobRecord): void {
    this.jobs.set(record.jobId, record);
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  removeJob(jobId: string): boolean {
    return this.jobs.delete(jobId);
  }
}
