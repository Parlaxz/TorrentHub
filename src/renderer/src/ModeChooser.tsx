import type { AppMode } from '@shared/domain'

interface Props {
  onChosen(mode: AppMode): void
}

export default function ModeChooser({ onChosen }: Props): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Welcome to Viking Relay</h1>
      <p className="max-w-md text-center text-sm text-neutral-400">
        Choose how this PC will be used. You can change this later from the header.
      </p>
      <div className="flex gap-4">
        <button
          type="button"
          className="rounded-lg border border-neutral-700 px-6 py-4 hover:border-sky-500 hover:bg-neutral-900"
          onClick={() => onChosen('client')}
        >
          <span className="block font-medium">Client PC</span>
          <span className="block text-xs text-neutral-500">Request torrents, receive files</span>
        </button>
        <button
          type="button"
          className="rounded-lg border border-neutral-700 px-6 py-4 hover:border-emerald-500 hover:bg-neutral-900"
          onClick={() => onChosen('server')}
        >
          <span className="block font-medium">Server PC</span>
          <span className="block text-xs text-neutral-500">Download, package, upload to Viking</span>
        </button>
      </div>
    </div>
  )
}
