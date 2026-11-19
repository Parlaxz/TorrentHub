import { useEffect, useState } from "react";
import { Button, ErrorText, Modal } from "./ui";
import type { Friend, VikingBridge } from "../lib/bridge";

/**
 * Recipient picker for "Send to Friend". The link is the intake source; the
 * selected qBittorrent file indexes ride along so the friend gets the subset.
 */
export function SendToFriendModal({
  open,
  onClose,
  bridge,
  source,
  fileIndexes,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  bridge: VikingBridge | null;
  source: string | null;
  fileIndexes: number[];
  onSent: () => void;
}) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [available, setAvailable] = useState<Array<{ clientId: string; name: string }>>([]);
  const [pickId, setPickId] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!open || !bridge) return;
    setError(null);
    setShowAdd(false);
    void bridge
      .friendsGet()
      .then((list) => {
        setFriends(list);
        setTarget((current) =>
          list.some((f) => f.clientId === current) ? current : (list[0]?.clientId ?? ""),
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load friends."));
  }, [open, bridge]);

  const displayName = (f: Friend): string => f.alias ?? f.name;

  const openAdd = async (): Promise<void> => {
    if (!bridge) return;
    setError(null);
    setShowAdd(true);
    try {
      const list = await bridge.clientsList();
      setAvailable(list);
      setPickId(list[0]?.clientId ?? "");
    } catch (err) {
      setAvailable([]);
      setError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  };

  const addFriend = (): void => {
    const pick = available.find((c) => c.clientId === pickId);
    if (!bridge || !pick) return;
    void bridge.friendsAdd(pick).then((list) => {
      setFriends(list);
      setTarget(pick.clientId);
    });
    setShowAdd(false);
  };

  const removeFriend = (clientId: string): void => {
    if (!bridge) return;
    void bridge.friendsRemove(clientId).then((list) => {
      setFriends(list);
      if (target === clientId) setTarget(list[0]?.clientId ?? "");
    });
  };

  const startRename = (f: Friend): void => {
    setRenamingId(f.clientId);
    setRenameDraft(f.alias ?? "");
    setError(null);
  };

  const saveRename = async (): Promise<void> => {
    if (!bridge || !renamingId) return;
    const res = await bridge.friendsRename(renamingId, renameDraft);
    if (res.ok) {
      setFriends(res.value);
      setRenamingId(null);
      setRenameDraft("");
    } else {
      setError(res.error);
    }
  };

  const send = async (): Promise<void> => {
    if (!bridge || !source || !target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.sendToFriend(source, target, fileIndexes);
      if (res.ok) onSent();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  };

  const sourcePreview = source
    ? source.length > 90
      ? `${source.slice(0, 90)}…`
      : source
    : "Link unavailable — reconnect to the server and retry.";

  return (
    <Modal open={open} onClose={onClose} title="Send to friend">
      <div className="space-y-3">
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <p className="truncate font-mono text-zinc-600 dark:text-zinc-300" title={source ?? undefined}>
            {sourcePreview}
          </p>
          <p className="mt-1 text-zinc-500 dark:text-zinc-500">
            {fileIndexes.length} selected file{fileIndexes.length === 1 ? "" : "s"} · the friend's app applies the
            same selection
          </p>
        </div>

        {friends.length === 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="no-friends">
            No friends yet. Add another paired client on this network.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {friends.map((f) => (
              <span
                key={f.clientId}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                  target === f.clientId
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
                title={f.alias ? `Paired as ${f.name}` : undefined}
              >
                <button
                  type="button"
                  onClick={() => setTarget(f.clientId)}
                  data-testid={`friend-${f.clientId}`}
                >
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
        )}

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
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700"
              data-testid={`friend-rename-input-${renamingId}`}
            />
            <Button onClick={() => void saveRename()} data-testid={`friend-rename-save-${renamingId}`}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setRenamingId(null)}>
              Cancel
            </Button>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => void openAdd()} data-testid="add-friend">
            + Add friend
          </Button>
          <Button onClick={() => void send()} disabled={busy || !target || !source} data-testid="send-to-friend">
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>

        {showAdd ? (
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700" data-testid="add-friend-panel">
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

        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
