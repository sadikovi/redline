import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TempRepo, lines } from "./helpers.js";

describe("relocation", () => {
  let repo, core;

  beforeEach(() => {
    repo = new TempRepo();
    repo.write("a.txt", lines(20));
    repo.write("b.txt", lines(5, "b"));
    repo.commit();
    // Round 1: change lines 10-11 in a.txt, delete b 3.
    repo.write("a.txt", lines(20).replace("line 10\n", "ten\n").replace("line 11\n", "eleven\n"));
    repo.write("b.txt", lines(5, "b").replace("b 3\n", ""));
    core = repo.core();
    core.start();
  });

  afterEach(() => repo.cleanup());

  const comment = (p, side, start, end) => core.addComment({ path: p, side, start, end, body: "fix" }).id;
  const requestChanges = async () => {
    core.submit({ verdict: "request_changes" });
    await core.wait(0);
  };
  const get = (cid) => core.review.comments.find((c) => c.id === cid);

  test("survives lines inserted above", async () => {
    const cid = comment("a.txt", "new", 10, 11);
    await requestChanges();
    repo.write("a.txt", "new top\nanother\n" + lines(20).replace("line 10\n", "ten\n").replace("line 11\n", "eleven\n"));
    core.push(`#${cid} reply: looking`);
    const c = get(cid);
    assert.deepEqual([c.state, c.start, c.end], ["open", 12, 13]);
  });

  test("outdated when lines edited", async () => {
    const cid = comment("a.txt", "new", 10, 11);
    await requestChanges();
    repo.write("a.txt", lines(20).replace("line 10\n", "TEN\n").replace("line 11\n", "eleven\n"));
    core.push("");
    assert.equal(get(cid).state, "outdated");
  });

  test("outdated when file deleted", async () => {
    const cid = comment("a.txt", "new", 10, 10);
    await requestChanges();
    repo.remove("a.txt");
    core.push("");
    assert.equal(get(cid).state, "outdated");
  });

  test("resolved thread relocates too", async () => {
    const cid = comment("a.txt", "new", 11, 11);
    await requestChanges();
    repo.write("a.txt", "top\n" + lines(20).replace("line 10\n", "ten\n").replace("line 11\n", "eleven\n"));
    core.push(`#${cid} resolve: done`);
    const c = get(cid);
    assert.deepEqual([c.state, c.start], ["resolved", 12]);
  });

  test("old side keeps numbers or goes outdated", async () => {
    const keep = comment("b.txt", "old", 3, 3);
    const gone = comment("a.txt", "old", 10, 10);
    await requestChanges();
    // Restore a.txt line 10: the deleted line is no longer in the diff.
    repo.write("a.txt", lines(20).replace("line 11\n", "eleven\n"));
    core.push("");
    assert.deepEqual([get(keep).state, get(keep).start], ["open", 3]);
    assert.equal(get(gone).state, "outdated");
  });
});
