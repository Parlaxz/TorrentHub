import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeMetadata } from "./fakes.ts";
import { makeHarness, waitFor } from "./harness.ts";

const MAGNET = "magnet:?xt=urn:btih:abcdef";

test("createIntake returns the draft before metadata settles", async () => {
  const h = makeHarness({ metadata: fakeMetadata(2) });

  const draft = await h.engine.createIntake(MAGNET, null, null, false);
  assert.equal(draft.state, "reading_metadata");
  assert.equal(draft.metadata, null);

  await waitFor(async () =>
    (await h.engine.getJob(draft.id)).state === "awaiting_selection" ? true : null,
  );
  const ready = await h.engine.getJob(draft.id);
  assert.equal(ready.metadata?.files.length, 2);
});

test("cancelling a draft stops the background metadata wait", async () => {
  const h = makeHarness({ metadata: fakeMetadata(1) });
  h.torrent.metadataDelayMs = 50;

  const draft = await h.engine.createIntake(MAGNET, null, null, false);
  assert.equal(draft.state, "reading_metadata");

  await h.engine.cancel(draft.id);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const after = await h.engine.getJob(draft.id);
  assert.equal(after.state, "cancelled");
  assert.equal(after.metadata, null);
});
