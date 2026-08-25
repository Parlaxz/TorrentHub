/**
 * Setup step 4 — Viking credentials.
 * Adapts to backend capability: anonymous allowed vs user hash required.
 * [Test] only rendered when the backend exposes a non-destructive validation.
 */

import { Button, TextField } from "../../../components/ui";
import type { StepProps } from "../SetupWizard";

export function StepViking({ bridge, state, dispatch }: StepProps) {
  const viking = state.viking;
  const canTest = typeof bridge.testViking === "function";

  const chooseAnonymous = async () => {
    // Anonymous mode = clear any stored hash server-side.
    dispatch({ type: "BUSY", key: "viking", busy: true });
    try {
      const config = await bridge.setVikingUserHash("");
      dispatch({ type: "VIKING_HASH_SAVED", config });
    } catch {
      dispatch({ type: "BUSY", key: "viking", busy: false });
    }
  };

  const saveHash = async () => {
    if (state.vikingHashInput.length === 0) return;
    dispatch({ type: "BUSY", key: "viking", busy: true });
    try {
      const config = await bridge.setVikingUserHash(state.vikingHashInput);
      dispatch({ type: "VIKING_HASH_SAVED", config });
    } catch {
      dispatch({ type: "BUSY", key: "viking", busy: false });
    }
  };

  const runTest = async () => {
    if (!bridge.testViking) return;
    dispatch({ type: "BUSY", key: "viking", busy: true });
    try {
      dispatch({ type: "VIKING_TEST_RESULT", result: await bridge.testViking() });
    } catch {
      dispatch({ type: "VIKING_TEST_RESULT", result: null });
    }
  };

  if (!viking) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading Viking configuration…</p>;
  }

  return (
    <div className="space-y-4">
      {viking.requiresUserHash || !viking.supportsAnonymous ? (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            This Viking API requires a user hash for uploads.
          </p>
          <TextField
            id="setup-viking-hash"
            label="Viking user hash"
            type="password"
            autoComplete="off"
            value={state.vikingHashInput}
            onChange={(event) => dispatch({ type: "VIKING_HASH_INPUT", value: event.target.value })}
            placeholder={viking.userHashMasked ?? ""}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={state.vikingBusy || state.vikingHashInput.length === 0}
              onClick={() => void saveHash()}
            >
              Save hash
            </Button>
            {canTest ? (
              <Button disabled={state.vikingBusy} onClick={() => void runTest()}>
                Test
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Upload as
            </legend>
            <label className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">
              <input
                type="radio"
                name="viking-mode"
                checked={viking.mode === "anonymous"}
                onChange={() => {
                  // Optimistic local flip: reflect the choice immediately
                  // instead of waiting for the persist round-trip.
                  dispatch({ type: "VIKING_MODE_PICK", mode: "anonymous" });
                  void chooseAnonymous();
                }}
              />
              <span>
                Anonymous
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  Uploads without linking a Viking account.
                </span>
              </span>
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">
              <input
                type="radio"
                name="viking-mode"
                checked={viking.mode === "user_hash"}
                onChange={() => {
                  // Reveal the hash field immediately; the mode flips locally
                  // and is persisted by "Save hash" below.
                  dispatch({ type: "VIKING_MODE_PICK", mode: "user_hash" });
                  document.getElementById("setup-viking-hash")?.focus();
                }}
              />
              <span>
                Viking account (user hash)
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  Attribute uploads to your account.
                </span>
              </span>
            </label>
          </fieldset>

          {viking.mode === "user_hash" || state.vikingHashInput.length > 0 ? (
            <TextField
              id="setup-viking-hash"
              label="Viking user hash"
              type="password"
              autoComplete="off"
              value={state.vikingHashInput}
              onChange={(event) => dispatch({ type: "VIKING_HASH_INPUT", value: event.target.value })}
              placeholder={viking.userHashMasked ?? ""}
              hint={viking.userHashMasked ? `Saved (${viking.userHashMasked})` : undefined}
            />
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={state.vikingBusy || state.vikingHashInput.length === 0}
              onClick={() => void saveHash()}
            >
              Save hash
            </Button>
            {canTest ? (
              <Button disabled={state.vikingBusy} onClick={() => void runTest()}>
                Test
              </Button>
            ) : null}
          </div>
        </>
      )}

      {state.vikingTest ? (
        <p
          role="status"
          className={`text-sm ${state.vikingTest.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
          data-testid="viking-test-result"
        >
          {state.vikingTest.ok ? "✓ " : "✕ "}
          {state.vikingTest.message}
        </p>
      ) : null}

      {viking.mode === "user_hash" && !state.vikingHashInput ? (
        <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
          User hash saved securely on this machine.
        </p>
      ) : null}
    </div>
  );
}
