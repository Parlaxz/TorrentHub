/**
 * Windows login item (start at boot). Shared by the server settings path and
 * the shell settings path so every writer registers identically.
 */
import { app } from 'electron'

export function applyLoginItem(open: boolean): void {
  if (process.platform !== 'win32') return
  app.setLoginItemSettings({
    openAtLogin: open,
    args: ['--hidden'],
  })
}
