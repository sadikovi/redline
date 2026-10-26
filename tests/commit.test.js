import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TempRepo, lines, review } from "./helpers.js";

describe("approve and commit", () => {
  let repo, core, head, approvedTree;

  beforeEach(() => {
    repo = new TempRepo();
    repo.write("a.txt", lines(5));
    repo.commit("base");
    head = repo.git("rev-parse", "HEAD").trim();
    repo.write("a.txt", lines(5).replace("line 2\n", "two\n"));
    repo.write("new.txt", "untracked\n");
    core = repo.core();
    core.start();
    approvedTree = repo.git("rev-parse", core.review.rounds.at(-1).commit + "^{tree}").trim();
  });

  afterEach(() => repo.cleanup());

  const approveCommit = () => {
    core.submit({ verdict: "approve_commit" });
    return core.wait(0);
  };
  const assertUntouched = (indexBefore) => {
    assert.equal(repo.git("rev-parse", "HEAD").trim(), head);
    assert.equal(repo.git("ls-files", "-s"), indexBefore);
  };

  test("commits the approved snapshot", async () => {
    assert.equal(await approveCommit(), "APPROVED round=1 commit=requested");
    const out = core.commit("Rename line two\n\nAdds new.txt too.\n");
    const sha = repo.git("rev-parse", "HEAD").trim();
    assert.equal(out, `committed ${sha.slice(0, 7)} on main`);
    assert.equal(repo.git("rev-parse", "HEAD^").trim(), head);
    assert.equal(repo.git("rev-parse", "HEAD^{tree}").trim(), approvedTree);
    assert.equal(repo.git("log", "-1", "--format=%an|%B").trim(), "Test|Rename line two\n\nAdds new.txt too.");
    assert.equal(repo.git("status", "--porcelain"), "");
    assert.equal(repo.git("for-each-ref", "refs/local-review"), "");
    assert.equal(core.review, null);
    assert.equal(core.payload().lastResult, out);
  });

  test("plain approve does not allow commit", async () => {
    core.submit({ verdict: "approve" });
    assert.equal(await core.wait(0), "APPROVED round=1");
    assert.throws(() => core.commit("msg"), review.ReviewError);
  });

  test("working tree changed after approval", async () => {
    await approveCommit();
    repo.write("a.txt", "something else\n");
    const indexBefore = repo.git("ls-files", "-s");
    assert.throws(() => core.commit("msg"), /approved snapshot/);
    assertUntouched(indexBefore);
    assert.equal(core.review.status, "approved");
  });

  test("branch moved", async () => {
    await approveCommit();
    repo.git("commit", "-q", "--allow-empty", "-m", "moved");
    assert.throws(() => core.commit("msg"), /moved/);
  });

  test("branch switched is rejected at submit", () => {
    repo.git("checkout", "-q", "-b", "other");
    assert.throws(() => core.submit({ verdict: "approve_commit" }), /not checked out/);
    assert.equal(core.review.status, "pending_review");
  });

  test("failing hook restores the index", async () => {
    repo.write("staged.txt", "partially staged\n");
    repo.git("add", "staged.txt");
    repo.remove("staged.txt");
    repo.write("staged.txt", "partially staged\n");
    core.end();
    core.start();
    await approveCommit();
    const hook = path.join(repo.dir, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", { mode: 0o755 });
    const indexBefore = repo.git("ls-files", "-s");
    assert.throws(() => core.commit("msg"), /lint failed/);
    assertUntouched(indexBefore);
    assert.equal(core.review.commitError, "git failed: lint failed");

    fs.unlinkSync(hook);
    assert.ok(core.commit("msg").startsWith("committed "));
  });
});

test("detached HEAD cannot commit", () => {
  const repo = new TempRepo();
  try {
    repo.write("a.txt", "a\n");
    repo.commit();
    repo.git("checkout", "-q", "--detach");
    repo.write("a.txt", "b\n");
    const core = repo.core();
    core.start();
    assert.throws(() => core.submit({ verdict: "approve_commit" }), review.ReviewError);
  } finally {
    repo.cleanup();
  }
});
