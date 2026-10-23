/**
 * Update-channel policy — pure and electron-free so it stays unit-testable.
 *
 * Why this exists (electron-updater GitHub provider semantics):
 *  - It requests `<channel>.yml` (`stable.yml` / `beta.yml`) from the newest
 *    release and treats a missing file as a hard `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`.
 *  - It only considers prereleases, and only falls back to `latest.yml` when
 *    the channel file is absent, if `autoUpdater.allowPrerelease` is set.
 *
 * The app never set `allowPrerelease`, so the beta channel 404'd every check
 * as soon as the newest release was a stable one without a `beta.yml` next
 * to it — and beta users were never offered prereleases at all. Tying the
 * flag to the channel fixes both: beta tolerates a missing `beta.yml`
 * (falls back to the stable feed) and actually tracks prereleases.
 */
export type UpdateChannel = 'stable' | 'beta';

/** Prereleases are only ever offered to the beta channel. */
export function allowPrereleaseFor(channel: UpdateChannel): boolean {
  return channel === 'beta';
}

/** Feed file electron-updater requests for a channel (`<channel>.yml`). */
export function feedFileFor(channel: UpdateChannel): string {
  return `${channel}.yml`;
}
