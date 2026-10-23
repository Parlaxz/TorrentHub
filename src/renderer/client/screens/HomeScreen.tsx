import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorText, Panel, SectionTitle, StatusDot } from "../components/ui";
import type { ConnectionStatus, Friend, SentDirectJobStatus, VikingBridge } from "../lib/bridge";
import { formatPercent, formatSpeed } from "../lib/format";

const MAGNET_RE = /^magnet:\?xt=urn:btih:[a-z0-9]{32,}/i;
const URL_RE = /^https?:\/\/\S+$/i;

export function validateIntakeInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste a magnet link or a torrent URL.";
  if (MAGNET_RE.test(v)) return null;
  if (/^magnet:/i.test(v)) return "That magnet link is missing its info hash (xt=urn:btih:…).";
  if (URL_RE.test(v)) return null;
  return "Enter a magnet URI or an HTTP(S) URL pointing to a .torrent file.";
}

/** Screen 2 — Home / submit (+ friends: client-to-client sends). */
export function HomeScreen({
  bridge,
  connection,
  onSubmit,
  busy,
  error,
}: {
  bridge: VikingBridge | null;
  connection: ConnectionStatus | null;
  onSubmit: (input: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const [friends, setFriends] = useState<Friend[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [available, setAvailable] = useState<Array<{ clientId: string; name: string }>>([]);
  const [pickId, setPickId] = useState("");
  const [sendTarget, setSendTarget] = useState("");
  const [friendLink, setFriendLink] = useState("");
  const [friendMsg, setFriendMsg] = useState<string | null>(null);
  const [friendError, setFriendError] = useState<string | null>(null);
  const [friendBusy, setFriendBusy] = useState(false);
  const [pasteBusy, setPasteBusy] = useState(false);

  // Inline nickname editing (local alias; the paired client name is kept).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  // Sender-side "ping": links sent this session + last on-demand status.
  // Fetched ONLY when the user clicks Check — never polled.
  interface SentEntry {
    id: string;
    targetName: string;
    sourcePreview: string;
    status: SentDirectJobStatus | null;
    checking: boolean;
  }
  const [sentEntries, setSentEntries] = useState<SentEntry[]>([]);

  useEffect(() => {
    if (!bridge) return;
    void bridge.friendsGet().then(setFriends).catch(() => {});
  }, [bridge]);

  const state = connection?.state ?? "offline";

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const invalid = validateIntakeInput(value);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    onSubmit(value.trim());
  };

  const openAddFriend = async (): Promise<void> => {
    if (!bridge) return;
    setFriendMsg(null);
    setFriendError(null);
    setShowAdd(true);
    try {
      const list = await bridge.clientsList();
      setAvailable(list);
      setPickId(list[0]?.clientId ?? "");
    } catch (err) {
      setAvailable([]);
      setFriendError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  };

  const addFriend = (): void => {
    const pick = available.find((c) => c.clientId === pickId);
    if (!bridge || !pick) return;
    void bridge.friendsAdd(pick).then(setFriends);
    setShowAdd(false);
    setSendTarget((t) => t || pick.clientId);
    setFriendMsg(`Added ${pick.name} as a friend.`);
  };

  const removeFriend = (clientId: string): void => {
    if (!bridge) return;
    void bridge.friendsRemove(clientId).then(setFriends);
    if (sendTarget === clientId) setSendTarget("");
  };

  const displayName = (f: Friend): string => f.alias ?? f.name;

  const startRename = (f: Friend): void => {
    setRenamingId(f.clientId);
    setRenameDraft(f.alias ?? "");
    setFriendMsg(null);
    setFriendError(null);
  };

  const saveRename = async (): Promise<void> => {
    if (!bridge || !renamingId) return;
    setRenameBusy(true);
    try {
      const res = await bridge.friendsRename(renamingId, renameDraft);
      if (res.ok) {
        setFriends(res.value);
        setRenamingId(null);
        setRenameDraft("");
      } else {
        setFriendError(res.error);
      }
    } finally {
      setRenameBusy(false);
    }
  };

  const pasteClipboard = async (): Promise<void> => {
    if (!bridge) return;
    setPasteBusy(true);
    setFriendError(null);
    try {
      const text = (await bridge.readText()).trim();
      if (!text) {
        setFriendError("Clipboard is empty — copy a magnet link or torrent URL first.");
        return;
      }
      setFriendLink(text);
    } finally {
      setPasteBusy(false);
    }
  };

  const sendToFriend = async (): Promise<void> => {
    if (!bridge || !sendTarget) return;
    const invalid = validateIntakeInput(friendLink);
    if (invalid) {
      setFriendError(invalid);
      return;
    }
    setFriendError(null);
    setFriendBusy(true);
    try {
      const target = friends.find((f) => f.clientId === sendTarget);
      const source = friendLink.trim();
      const res = await bridge.sendToFriend(source, sendTarget);
      if (res.ok) {
        setFriendLink("");
        setFriendMsg("Sent ✓");
        window.setTimeout(() => setFriendMsg(null), 2500);
        const preview = source.length > 64 ? `${source.slice(0, 64)}…` : source;
        setSentEntries((prev) =>
          [
            {
              id: res.value.id,
              targetName: target ? displayName(target) : sendTarget,
              sourcePreview: preview,
              status: null,
              checking: false,
            },
            ...prev,
          ].slice(0, 10),
        );
      } else {
        setFriendError(res.error);
      }
    } finally {
      setFriendBusy(false);
    }
  };

  /** On-demand "ping": one status fetch per click, never polled. */
  const checkSentStatus = async (id: string): Promise<void> => {
    if (!bridge) return;
    setSentEntries((prev) => prev.map((e) => (e.id === id ? { ...e, checking: true } : e)));
    try {
      const status = await bridge.directJobStatus(id);
      setSentEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status, checking: false } : e)),
      );
    } catch {
      setSentEntries((prev) => prev.map((e) => (e.id === id ? { ...e, checking: false } : e)));
      setFriendError("Could not reach the server for that status check.");
    }
  };

  const describeSentState = (status: SentDirectJobStatus): string => {
    if (status.state === "queued") return "Waiting — your friend hasn't opened it yet";
    if (status.state === "declined") return "Declined by your friend";
    if (status.state !== "accepted") return status.state;
    const p = status.progress;
    if (p?.progressPct != null && p.progressPct >= 100) return "Complete ✓ — 100% on your friend's PC";
    if (p?.progressPct != null) {
      const age = ageAgo(p.updatedAt);
      return `Downloading — ${formatPercent(p.progressPct)} • ${formatSpeed(p.dlSpeedBps)}${age ? ` • ${age}` : ""}`;
    }
    return "Received ✓ — download started on your friend's PC";
  };

  const ageAgo = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const s = Math.floor(ms / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  };

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-8">
      <Panel>
        <SectionTitle>Server</SectionTitle>
        <div className="mb-5 flex items-center gap-2 text-sm">
          <StatusDot state={state} />
          <span
            className={`font-semibold capitalize ${
              state === "connected"
                ? "text-emerald-600 dark:text-emerald-400"
                : state === "reconnecting"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
            }`}
          >
            {state}
          </span>
          {connection?.host ? (
            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
              {connection.host}
              {connection.port ? `:${connection.port}` : ""}
            </span>
          ) : null}
        </div>

        <SectionTitle>Torrent / Magnet</SectionTitle>
        <form onSubmit={submit} noValidate>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="magnet:?xt=urn:btih:…"
            aria-label="Torrent magnet link or URL"
            aria-invalid={Boolean(localError) || undefined}
            spellCheck={false}
            autoComplete="off"
            disabled={busy || state !== "connected"}
            className={`w-full rounded-md border bg-white px-3 py-2 font-mono text-[13px] text-zinc-900 placeholder:text-zinc-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
              localError || error
                ? "border-red-500 focus:ring-red-500/60"
                : "border-zinc-300 focus:border-blue-500 dark:border-zinc-700"
            }`}
          />
          <ErrorText>{localError ?? error}</ErrorText>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-600">Magnet URI or HTTP(S) .torrent URL</p>
            <Button type="submit" disabled={busy || state !== "connected"}>
              Continue
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="mt-4">
        <SectionTitle
          right={
            <Button variant="ghost" onClick={() => void openAddFriend()} data-testid="add-friend">
              + Add friend
            </Button>
          }
        >
          Friends
        </SectionTitle>

        {friends.length === 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="no-friends">
            No friends yet. Add other clients on this Radmin network to send them links directly.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {friends.map((f) => (
                <span
                  key={f.clientId}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                    sendTarget === f.clientId
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                  }`}
                  title={f.alias ? `Paired as ${f.name}` : undefined}
                >
                  <button type="button" onClick={() => setSendTarget(f.clientId)} data-testid={`friend-${f.clientId}`}>
                    {displayName(f)}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${displayName(f)}`}
                    title="Give this friend a nickname"
                    className="text-zinc-400 hover:text-blue-500"
                    onClick={() => startRename(f)}
                    data-testid={`friend-rename-${f.clientId}`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${displayName(f)}`}
                    className="text-zinc-400 hover:text-red-500"
                    onClick={() => removeFriend(f.clientId)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>

            {renamingId ? (
              <div className="flex gap-2" data-testid="friend-rename-panel">
                <input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  placeholder="Nickname (blank = paired name)"
                  aria-label="Friend nickname"
                  maxLength={32}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={renameBusy}
                  className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700"
                  data-testid={`friend-rename-input-${renamingId}`}
                />
                <Button
                  onClick={() => void saveRename()}
                  disabled={renameBusy}
                  data-testid={`friend-rename-save-${renamingId}`}
                >
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setRenamingId(null)} disabled={renameBusy}>
                  Cancel
                </Button>
              </div>
            ) : null}

            <div className="flex gap-2">
              <input
                value={friendLink}
                onChange={(e) => setFriendLink(e.target.value)}
                placeholder="Link to send…"
                aria-label="Link to send to friend"
                spellCheck={false}
                autoComplete="off"
                disabled={state !== "connected" || !sendTarget}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-[13px] text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700"
                data-testid="friend-link-input"
              />
              <Button
                variant="ghost"
                onClick={() => void pasteClipboard()}
                disabled={pasteBusy || state !== "connected"}
                data-testid="friend-paste"
                title="Paste from clipboard"
              >
                Paste
              </Button>
              <Button
                onClick={() => void sendToFriend()}
                disabled={friendBusy || state !== "connected" || !sendTarget}
                data-testid="send-to-friend"
              >
                Send
              </Button>
            </div>
            {!sendTarget ? (
              <p className="text-[11px] text-zinc-400 dark:text-zinc-600">Pick a friend above to enable sending.</p>
            ) : null}
            {friendMsg ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{friendMsg}</p> : null}
            {friendError ? <ErrorText>{friendError}</ErrorText> : null}
            {sentEntries.length > 0 ? (
              <div className="space-y-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-800" data-testid="friend-sent-list">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                  Sent — check status on demand
                </p>
                {sentEntries.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-zinc-500 dark:text-zinc-400" title={e.sourcePreview}>
                      → {e.targetName}: {e.sourcePreview}
                    </span>
                    <span className="shrink-0 text-zinc-600 dark:text-zinc-300" data-testid={`friend-status-${e.id}`}>
                      {e.status ? describeSentState(e.status) : "Sent — not checked yet"}
                    </span>
                    <Button
                      variant="ghost"
                      className="shrink-0 px-2 py-0.5 text-xs"
                      onClick={() => void checkSentStatus(e.id)}
                      disabled={e.checking || state !== "connected"}
                      data-testid={`friend-status-check-${e.id}`}
                    >
                      {e.checking ? "Checking…" : "Check"}
                    </Button>
                  </div>
                ))}
                <p className="text-[11px] text-zinc-400 dark:text-zinc-600">
                  Status is fetched only when you press Check — never polled. Percent and
                  speed come from your friend's app (magnet links only); if they're offline
                  you'll see the last report they sent.
                </p>
              </div>
            ) : null}
          </div>
        )}

        {showAdd ? (
          <div className="mt-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700" data-testid="add-friend-panel">
            {available.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No other paired clients found on the server.
              </p>
            ) : (
              <>
                <select
                  value={pickId}
                  onChange={(e) => setPickId(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  aria-label="Choose paired client"
                  data-testid="add-friend-select"
                >
                  {available.map((c) => (
                    <option key={c.clientId} value={c.clientId}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setShowAdd(false)}>
                    Cancel
                  </Button>
                  <Button onClick={addFriend} disabled={!pickId} data-testid="add-friend-confirm">
                    Add
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
