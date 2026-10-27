import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TempRepo, review } from "./helpers.js";

describe("snapshot", () => {
  let repo;

  beforeEach(() => {
    repo = new TempRepo();
    repo.write(".gitignore", "*.log\n");
    repo.write("tracked.txt", "one\n");
    repo.commit();
  });

  afterEach(() => repo.cleanup());

  test("untracked included, ignored excluded, index untouched", () => {
    repo.write("tracked.txt", "one\ntwo\n");
    repo.write("new/untracked.txt", "hello\n");
    repo.write("debug.log", "noise\n");
    repo.write("staged.txt", "staged\n");
    repo.git("add", "staged.txt");
    const indexBefore = repo.git("ls-files", "-s");
    const statusBefore = repo.git("status", "--porcelain");

    const core = repo.core();
    core.start();
    const paths = Object.fromEntries(core.diff().files.map((f) => [f.path, f.status]));

    assert.deepEqual(paths, { "tracked.txt": "M", "new/untracked.txt": "A", "staged.txt": "A" });
    assert.equal(repo.git("ls-files", "-s"), indexBefore);
    assert.equal(repo.git("status", "--porcelain"), statusBefore);
  });

  test("round ref written and no changes rejected", () => {
    const core = repo.core();
    assert.throws(() => core.start(), /no changes/);
    assert.equal(repo.git("for-each-ref", "refs/redline"), "");
    assert.equal(core.review, null);

    repo.write("tracked.txt", "changed\n");
    core.start();
    const refs = repo.git("for-each-ref", "--format=%(refname)", "refs/redline").split(/\s+/).filter(Boolean);
    assert.deepEqual(refs, [`refs/redline/${core.review.id}/round-1`]);
  });

  test("base ref uses merge-base", () => {
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("feature.txt", "f\n");
    repo.commit("feature");
    const core = repo.core();
    core.start("main");
    assert.deepEqual(core.diff().files.map((f) => f.path), ["feature.txt"]);
    assert.equal(core.review.base, repo.git("rev-parse", "main").trim());
  });

  test("bad ref rejected", () => {
    repo.write("tracked.txt", "changed\n");
    assert.throws(() => repo.core().start("--output=/tmp/x"), review.ReviewError);
  });
});
