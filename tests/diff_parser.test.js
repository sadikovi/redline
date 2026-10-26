import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { TempRepo, lines, review } from "./helpers.js";

describe("diff parser", () => {
  let repo, files;

  before(() => {
    repo = new TempRepo();
    repo.write("modify.txt", lines(10));
    repo.write("delete.txt", "gone\n");
    repo.write("old_name.txt", lines(20, "keep"));
    repo.write("image.bin", Buffer.from("\x00\x01\x02binary", "latin1"));
    repo.write("noeol.txt", "a\nb");
    repo.commit();

    repo.write("modify.txt", lines(10).replace("line 5\n", "line five\n"));
    repo.remove("delete.txt");
    repo.git("mv", "old_name.txt", "new name.txt");
    repo.write("added.txt", "x\ny\n");
    repo.write("image.bin", Buffer.from("\x00\x01\x03binary!", "latin1"));
    repo.write("noeol.txt", "a\nc");
    repo.write("empty.txt", "");
    const core = repo.core();
    core.start();
    files = Object.fromEntries(core.diff().files.map((f) => [f.path, f]));
  });

  after(() => repo.cleanup());

  test("add", () => {
    const f = files["added.txt"];
    assert.deepEqual([f.status, f.additions, f.deletions], ["A", 2, 0]);
    assert.deepEqual(f.hunks[0].lines.map((l) => [l.type, l.new, l.text]), [["add", 1, "x"], ["add", 2, "y"]]);
  });

  test("modify", () => {
    const f = files["modify.txt"];
    assert.deepEqual([f.status, f.additions, f.deletions], ["M", 1, 1]);
    const hunk = f.hunks[0];
    assert.ok(hunk.header.startsWith("@@ -2,7 +2,7 @@"));
    const dels = hunk.lines.filter((l) => l.type === "del");
    const adds = hunk.lines.filter((l) => l.type === "add");
    assert.deepEqual([dels[0].old, dels[0].text], [5, "line 5"]);
    assert.deepEqual([adds[0].new, adds[0].text], [5, "line five"]);
    const ctx = hunk.lines[0];
    assert.deepEqual([ctx.type, ctx.old, ctx.new], ["ctx", 2, 2]);
  });

  test("delete", () => {
    const f = files["delete.txt"];
    assert.deepEqual([f.status, f.deletions, f.oldPath], ["D", 1, "delete.txt"]);
  });

  test("rename with space", () => {
    const f = files["new name.txt"];
    assert.deepEqual([f.status, f.oldPath, f.hunks], ["R", "old_name.txt", []]);
  });

  test("binary", () => {
    const f = files["image.bin"];
    assert.ok(f.binary);
    assert.deepEqual(f.hunks, []);
  });

  test("no newline at end", () => {
    const f = files["noeol.txt"];
    assert.deepEqual(f.hunks[0].lines.map((l) => [l.type, l.text, l.noeol || false]),
      [["ctx", "a", false], ["del", "b", true], ["add", "c", true]]);
  });

  test("empty file", () => {
    const f = files["empty.txt"];
    assert.deepEqual([f.status, f.hunks, f.binary], ["A", [], false]);
  });

  test("quoted paths", () => {
    const text = 'diff --git "a/t\\tab.txt" "b/t\\tab.txt"\n' +
      "new file mode 100644\n" +
      "index 0000000..e69de29\n" +
      "diff --git a/x b/y z\n" +
      "similarity index 100%\n" +
      "rename from x\n" +
      'rename to "y z"\n';
    const parsed = review.parseDiff(text);
    assert.equal(parsed[0].path, "t\tab.txt");
    assert.deepEqual([parsed[1].oldPath, parsed[1].path], ["x", "y z"]);
  });

  test("octal-escaped UTF-8 path", () => {
    const parsed = review.parseDiff('diff --git "a/caf\\303\\251" "b/caf\\303\\251"\nnew file mode 100644\n');
    assert.equal(parsed[0].path, "café");
  });

  test("collectRange", () => {
    const f = files["modify.txt"];
    assert.deepEqual(review.collectRange(f, "new", 4, 6), ["line 4", "line five", "line 6"]);
    assert.deepEqual(review.collectRange(f, "old", 5, 5), ["line 5"]);
    assert.equal(review.collectRange(f, "old", 4, 5), null); // line 4 is context, not deleted
    assert.equal(review.collectRange(f, "new", 8, 12), null); // runs past the hunk
  });
});
