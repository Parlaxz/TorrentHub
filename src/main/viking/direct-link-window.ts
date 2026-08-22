/**
 * Window-based Viking direct-link resolver.
 *
 * The /f/ page generates the /d/ link via its own JavaScript (often behind a
 * Cloudflare Turnstile challenge). A headless HTTP call cannot pass that, but
 * a real Chromium window can: we load the page, let the site run, poll the
 * #download-link anchor its script populates, capture the href, and close.
 *
 * The window is small but VISIBLE on purpose — invisible/automated contexts
 * are what Turnstile punishes, and if an interactive challenge appears the
 * user can solve it with one click.
 */
import { BrowserWindow } from 'electron';
import type { Logger } from 'pino';

const POLL_INTERVAL_MS = 500;
const RESOLVE_TIMEOUT_MS = 90_000;

let inFlight: Promise<string | null> | null = null;

export function resolveDirectLinkViaWindow(
  pageUrl: string,
  log: Logger,
): Promise<string | null> {
  // One at a time: two popups racing the same captcha helps nobody.
  if (inFlight) return inFlight;
  inFlight = runResolution(pageUrl, log).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function runResolution(pageUrl: string, log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const finish = (link: string | null): void => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        win?.destroy();
      } catch {
        /* already gone */
      }
      log.info({ link: link ?? null }, 'direct-link window resolution finished');
      resolve(link);
    };

    log.info({ pageUrl }, 'opening resolver window for direct link');
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      show: true,
      title: 'Viking Relay — resolving direct link…',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    win.on('closed', () => {
      finish(null);
    });

    timeoutTimer = setTimeout(() => {
      log.warn('direct-link resolution timed out');
      finish(null);
    }, RESOLVE_TIMEOUT_MS);

    void win
      .loadURL(pageUrl)
      .then(() => {
        pollTimer = setInterval(() => {
          if (settled || win.isDestroyed()) return;
          void win.webContents
            .executeJavaScript(
              `(function(){var a=document.getElementById('download-link');` +
                `if(a&&a.href&&/^https?:\\/\\//i.test(a.href))return a.href;return null;})()`,
            )
            .then((href: unknown) => {
              if (typeof href === 'string' && href.length > 0) {
                finish(href);
              }
            })
            .catch(() => {
              /* navigation in progress */
            });
        }, POLL_INTERVAL_MS);
      })
      .catch((err) => {
        log.warn({ err: String(err) }, 'failed to load direct-link page');
        finish(null);
      });
  });
}
