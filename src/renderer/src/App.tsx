import { useEffect, useState } from 'react'
import type { AppState } from '@shared/ipc'
import ClientApp from '../client'
import ServerApp from '../server'
import ModeChooser from './ModeChooser'

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [bridgeMissing, setBridgeMissing] = useState(false)

  useEffect(() => {
    if (!window.vikingRelay) {
      setBridgeMissing(true)
      return
    }
    void window.vikingRelay.getState().then(setState)
  }, [])

  if (bridgeMissing) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-red-400">
          Preload bridge unavailable. The app window must be launched by Viking Relay itself.
        </p>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-neutral-500">Loading…</p>
      </div>
    )
  }

  const refresh = (): Promise<void> => window.vikingRelay.getState().then(setState)

  async function switchMode(next: 'client' | 'server'): Promise<void> {
    setState(await window.vikingRelay.setMode(next))
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <span className="text-sm font-semibold tracking-wide">Viking Relay</span>
        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono uppercase">
            {state.mode ?? 'unconfigured'}
          </span>
          {state.mode !== null && (
            <button
              type="button"
              className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
              onClick={() => switchMode(state.mode === 'client' ? 'server' : 'client')}
            >
              Switch mode
            </button>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1">
        {state.mode === null ? (
          <ModeChooser onChosen={(m) => switchMode(m).then(refresh)} />
        ) : state.mode === 'client' ? (
          <ClientApp />
        ) : (
          <ServerApp />
        )}
      </main>
    </div>
  )
}
