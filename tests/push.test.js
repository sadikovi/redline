import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TempRepo, lines, review } from "./helpers.js";

describe("push parsing", () => {
  test("valid", () => {
    const text = "#3 resolve: Renamed and added None check.\n\n#4 reply: Intentional: see line 88.\n#6 resolve\n";
    assert.deepEqual(review.parsePush(text), {
      entries: [
        [3, "resolve", "Renamed and added None check."],
        [4, "reply", "Intentional: see line 88."],
        [6, "resolve", null],
      ],
      summary: null,
    });
  });

  test("summary answer", () => {
    assert.deepEqual(review.parsePush("summary: Split it up.\n#3 resolve"), {
      entries: [[3, "resolve", null]],
      summary: "Split it up.",
    });
  });

  test("invalid", () => {
    for (const bad of ["#3 fixed it", "3 resolve: x", "#4 reply", "#4 reply:   ", "summary:", "summary: a\nsummary: b"]) {
      assert.throws(() => review.parsePush(bad), review.ReviewError, bad);
    }
  });
});

describe("push", () => {
  let repo, core;

  beforeEach(async () => {
    repo = new TempRepo();
    repo.write("a.txt", lines(10));
    repo.commit();
    repo.write("a.txt", lines(10).replace("line 2\n", "two\n").replace("line 8\n", "eight\n"));
    core = repo.core();
    core.start();
    for (const n of [2, 8]) core.addComment({ path: "a.txt", side: "new", start: n, end: n, body: "why?" });
    core.submit({ verdict: "request_changes" });
    await core.wait(0);
  });

  afterEach(() => repo.cleanup());

  test("unknown id rejected atomically", () => {
    const beforeReview = core.review;
    const refs = repo.git("for-each-ref", "refs/redline");
    assert.throws(() => core.push("#1 resolve: done\n#99 reply: what"), /#99/);
    assert.equal(core.review, beforeReview);
    assert.equal(repo.git("for-each-ref", "refs/redline"), refs);
  });

  test("unanswered listed", () => {
    assert.equal(core.push("#1 resolve: done"), "round 2 ok; unanswered: #2");
    const r = core.review;
    assert.equal(r.status, "pending_review");
    assert.deepEqual(r.comments.map((c) => c.state), ["resolved", "open"]);
    const last = r.comments[0].thread.at(-1);
    assert.deepEqual([last.author, last.body, last.round], ["claude", "done", 2]);
  });

  test("all answered", () => {
    assert.equal(core.push("#1 resolve: done\n#2 reply: because"), "round 2 ok");
    assert.equal(core.review.rounds.length, 2);
  });

  test("summary answer is not accepted without a summary", () => {
    assert.throws(() => core.push("summary: ok\n#1 resolve\n#2 resolve"), /no summary/);
    assert.equal(core.review.status, "changes_requested");
  });

  test("push requires changes requested", () => {
    core.push("#1 resolve\n#2 resolve");
    assert.throws(() => core.push("#1 resolve"), review.ReviewError);
  });
});

describe("summary-only review", () => {
  let repo, core;

  beforeEach(async () => {
    repo = new TempRepo();
    repo.write("a.txt", lines(3));
    repo.commit();
    repo.write("a.txt", lines(4));
    core = repo.core();
    core.start();
    core.submit({ verdict: "request_changes", summary: "Add a test." });
    assert.equal(await core.wait(0), "CHANGES_REQUESTED round=1 comments=0\nSUMMARY: Add a test.");
  });

  afterEach(() => repo.cleanup());

  test("answer is stored on the summary", () => {
    assert.equal(core.push("summary: Added one."), "round 2 ok");
    const r = core.review;
    assert.equal(r.status, "pending_review");
    assert.deepEqual([r.summaries[0].reply.body, r.summaries[0].reply.round], ["Added one.", 2]);
  });

  test("missing answer is listed as unanswered", () => {
    assert.equal(core.push(""), "round 2 ok; unanswered: summary");
  });
});
