import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TempRepo, lines, review } from "./helpers.js";

describe("push parsing", () => {
  test("valid", () => {
    const text = "#3 resolve: Renamed and added None check.\n\n#4 reply: Intentional: see line 88.\n#6 resolve\n";
    assert.deepEqual(review.parsePush(text), [
      [3, "resolve", "Renamed and added None check."],
      [4, "reply", "Intentional: see line 88."],
      [6, "resolve", null],
    ]);
  });

  test("invalid", () => {
    for (const bad of ["#3 fixed it", "3 resolve: x", "#4 reply", "#4 reply:   "]) {
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

  test("push requires changes requested", () => {
    core.push("#1 resolve\n#2 resolve");
    assert.throws(() => core.push("#1 resolve"), review.ReviewError);
  });
});
