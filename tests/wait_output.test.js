import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GOLDEN, TempRepo, lines, review } from "./helpers.js";

function golden(name) {
  return fs.readFileSync(path.join(GOLDEN, name), "utf8").replace(/\n+$/, "");
}

// Reproduces the example from the spec, then follow-up and approval rounds.
describe("wait output", () => {
  let repo, core;

  beforeEach(() => {
    repo = new TempRepo();
    repo.write("src/parser.py", lines(41, "# filler"));
    repo.write("src/util.py", lines(9, "# u") + "retries = 3\n" + lines(5, "# v"));
    repo.commit();
    repo.write("src/parser.py", lines(41, "# filler") + 'def parse(h):\n    return h.split(":")\n\n# end\n');
    repo.write("src/util.py", lines(9, "# u") + lines(5, "# v"));
    core = repo.core();
    core.start();
    // Burn ids 1 and 2 so the comments get the ids used in the spec.
    for (let i = 0; i < 2; i++) {
      const c = core.addComment({ path: "src/util.py", side: "old", start: 10, end: 10, body: "x" });
      core.deleteComment(c.id);
    }
    core.addComment({ path: "src/parser.py", side: "new", start: 42, end: 45,
      body: "Rename to parse_header and handle None." });
    core.addComment({ path: "src/util.py", side: "old", start: 10, end: 10, body: "Why was this removed?" });
  });

  afterEach(() => repo.cleanup());

  test("changes requested, follow-up, approved", async () => {
    core.submit({ verdict: "request_changes", summary: "Mostly good, just these two." });
    const text = await core.wait(0);
    assert.equal(text, golden("changes_requested.txt"));
    assert.ok(text.length < 480); // ~120 tokens at ~4 chars/token

    // Already consumed: never returned twice.
    assert.equal(await core.wait(0), "TIMEOUT");

    core.push("#3 resolve: Renamed.\n#4 reply: Intentional; callers rely on it.");
    core.addReply(4, { body: "Please restore it." });
    core.submit({ verdict: "request_changes" });
    assert.equal(await core.wait(0), golden("followup.txt"));

    core.push("#4 resolve: Restored.");
    core.submit({ verdict: "approve" });
    assert.equal(await core.wait(0), golden("approved.txt"));
  });

  test("timeout", async () => {
    assert.equal(await core.wait(0), golden("timeout.txt"));
  });

  test("request changes needs a comment or summary", async () => {
    for (const c of [...core.review.comments]) core.deleteComment(c.id);
    assert.throws(() => core.submit({ verdict: "request_changes" }), review.ReviewError);
    core.submit({ verdict: "request_changes", summary: "Rethink this." });
    assert.equal(await core.wait(0), "CHANGES_REQUESTED round=1 comments=0\nSUMMARY: Rethink this.");
  });

  test("snippet truncation", () => {
    assert.deepEqual(review.formatSnippet(["x".repeat(150)]), ["> " + "x".repeat(99) + "…"]);
    assert.deepEqual(review.formatSnippet(["a", "b", "c"]), ["> a", "> b", "...(+1)"]);
  });
});
