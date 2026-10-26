import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectRange, findAnchor, parseDiff } from "./diff.js";
import { APPROVED, CHANGES, PENDING, attention, formatWait, parsePush } from "./format.js";
import { Git } from "./git.js";
import { ReviewError, nowIso, readJson, splitlines, unlinkQuiet, writeFileSafe, writeJson } from "./util.js";

export const DEFAULT_WAIT = 1800;
const EVENTS_TIMEOUT = 25;
const ARCHIVE_MAX_AGE = 30 * 86400;
const MAX_COMMENT = 65536;
const REF_PREFIX = "refs/local-review/";
const IDENTITY = {
  GIT_AUTHOR_NAME: "local-review", GIT_AUTHOR_EMAIL: "local-review@localhost",
  GIT_COMMITTER_NAME: "local-review", GIT_COMMITTER_EMAIL: "local-review@localhost",
};

/**
 * All review state and logic. Every mutation bumps `version` and wakes waiters.
 * Git runs synchronously, so each operation is atomic on the event loop; only
 * `wait` and `events` yield while they block.
 */
export class Core {
  constructor(repo) {
    this.repo = repo;
    this.git = new Git(repo.top);
    this.stateDir = repo.stateDir;
    this.archiveDir = path.join(this.stateDir, "archive");
    fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    this.reviewPath = path.join(this.stateDir, "review.json");
    this.version = 1;
    this.closing = false;
    this.url = "";
    this.lastRequest = Date.now();
    this.lastResult = null; // shown by the UI after a review is committed
    this._diffCache = new Map();
    this._waiters = new Set();
    this.review = readJson(this.reviewPath);
  }

  // -- persistence

  _commit(r) {
    if (r === null) unlinkQuiet(this.reviewPath);
    else writeJson(this.reviewPath, r);
    this.review = r;
    this._bump();
  }

  /** Wake every long-poll so it re-checks its condition. */
  wake() {
    for (const done of this._waiters) done();
    this._waiters.clear();
  }

  _bump() {
    this.version += 1;
    this.wake();
  }

  /** Resolve on the next state change, on close, or after `ms`. */
  _changed(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this._waiters.add(done);
    });
  }

  close() {
    this.closing = true;
    this.wake();
  }

  _require(status) {
    const r = this.review;
    if (r === null) throw new ReviewError("no active review", 404);
    if (status && r.status !== status) throw new ReviewError(`review is ${r.status}`, 409);
    return structuredClone(r);
  }

  // -- git

  /** Tree of the whole working tree (untracked included), via a temporary index. */
  _worktreeTree() {
    const idx = path.join(this.stateDir, "index.tmp");
    unlinkQuiet(idx);
    const env = { GIT_INDEX_FILE: idx };
    this.git.run(["read-tree", "HEAD"], { env });
    this.git.run(["add", "-A"], { env });
    return this.git.out(["write-tree"], { env });
  }

  _snapshot(rid, n, base) {
    const tree = this._worktreeTree();
    const commit = this.git.out(["commit-tree", "--no-gpg-sign", tree, "-p", base,
      "-m", `local-review ${rid} round ${n}`], { env: IDENTITY });
    this.git.run(["update-ref", `${REF_PREFIX}${rid}/round-${n}`, commit]);
    return [commit, tree];
  }

  _diff(a, b) {
    const key = a + " " + b;
    if (!this._diffCache.has(key)) {
      const p = this.git.run(["-c", "core.quotePath=false", "-c", "diff.relative=false",
        "diff", "--no-color", "--no-ext-diff", "--no-textconv",
        "--submodule=short", "--find-renames", "-U3",
        "--src-prefix=a/", "--dst-prefix=b/", a, b, "--"]);
      if (this._diffCache.size > 32) this._diffCache.clear();
      this._diffCache.set(key, parseDiff(p.stdout.toString()));
    }
    return this._diffCache.get(key);
  }

  _fileLines(commit, p) {
    const res = this.git.run(["cat-file", "blob", `${commit}:${p}`], { check: false });
    if (res.status !== 0) return null;
    const lines = res.stdout.toString().split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  _refs(rid) {
    const out = this.git.out(["for-each-ref", "--format=%(refname)", REF_PREFIX + (rid ? rid + "/" : "")]);
    return splitlines(out).filter((x) => x);
  }

  _deleteRefs(refs) {
    if (refs.length) {
      this.git.run(["update-ref", "--stdin"], { input: refs.map((r) => `delete ${r}\n`).join("") });
    }
  }

  /** Ids of unfinished reviews in this and every other worktree (refs are shared). */
  _activeIds() {
    const ids = new Set(this.review ? [this.review.id] : []);
    const paths = [path.join(this.repo.commonDir, "local-review", "review.json")];
    const wt = path.join(this.repo.commonDir, "worktrees");
    const names = fs.existsSync(wt) ? fs.readdirSync(wt) : [];
    for (const name of names) paths.push(path.join(wt, name, "local-review", "review.json"));
    for (const p of paths) {
      const other = readJson(p);
      if (other && typeof other === "object" && other.id) ids.add(other.id);
    }
    return ids;
  }

  _cleanup() {
    const keep = this._activeIds();
    this._deleteRefs(this._refs().filter((r) => !keep.has(r.slice(REF_PREFIX.length).split("/")[0])));
    const cutoff = Date.now() - ARCHIVE_MAX_AGE * 1000;
    for (const name of fs.readdirSync(this.archiveDir)) {
      if (!name.endsWith(".json")) continue;
      const p = path.join(this.archiveDir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* raced with another cleanup */ }
    }
  }

  _archive(r) {
    r = { ...r, archivedAt: nowIso() };
    writeJson(path.join(this.archiveDir, r.id + ".json"), r);
    this._deleteRefs(this._refs(r.id));
    this._commit(null);
  }

  // -- CLI operations

  start(ref = null, title = null, isNew = false) {
    this._cleanup();
    let r = this.review;
    if (r && (isNew || r.status === APPROVED)) {
      this._archive(r);
      r = null;
    }
    if (r) {
      const n = r.rounds.length;
      if (r.status === CHANGES && r.consumed >= n) {
        // The previous session received the comments but never pushed.
        r = structuredClone(r);
        r.consumed = n - 1;
        this._commit(r);
      }
      let line = `resumed ${r.id} round ${n} ${r.status}`;
      if (r.status === CHANGES) line += ` comments=${attention(r).length}`;
      return line + " " + this.url;
    }
    const headSha = this.git.tryOut(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (!headSha) throw new ReviewError("repository has no commits");
    let base = headSha;
    if (ref) base = this.git.out(["merge-base", base, this.git.verifyCommit(ref)]);
    let rid = crypto.randomBytes(3).toString("hex");
    while (this._refs(rid).length) rid = crypto.randomBytes(3).toString("hex");
    const [commit, tree] = this._snapshot(rid, 1, base);
    if (tree === this.git.out(["rev-parse", base + "^{tree}"])) {
      this._deleteRefs(this._refs(rid));
      throw new ReviewError("no changes to review");
    }
    const branch = this.git.tryOut(["symbolic-ref", "--short", "-q", "HEAD"]);
    r = {
      id: rid,
      title: title || "",
      branch,
      head: headSha,
      base,
      status: PENDING,
      rounds: [{ n: 1, commit, createdAt: nowIso() }],
      consumed: 0,
      nextCommentId: 1,
      comments: [],
      summaries: [],
      createdAt: nowIso(),
    };
    this._commit(r);
    return `review ${rid} round 1 ${this.url}`;
  }

  status() {
    const r = this._require();
    const open = r.comments.filter((c) => c.state === "open").length;
    return `${r.id} round ${r.rounds.length} ${r.status} open=${open}`;
  }

  end() {
    const r = this._require();
    this._archive(r);
    return `ended ${r.id}`;
  }

  /** The original branch must be checked out and still at the review's starting commit. */
  _checkCommitTarget(r) {
    if (!r.branch || !r.head) throw new ReviewError("review was not started on a branch; cannot commit", 409);
    const cur = this.git.tryOut(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (cur !== r.branch) throw new ReviewError(`branch ${r.branch} is not checked out`, 409);
    if (this.git.out(["rev-parse", "HEAD"]) !== r.head) {
      throw new ReviewError(`${r.branch} has moved since the review started`, 409);
    }
  }

  /** Commit the approved snapshot on the original branch with `git commit` (hooks run). */
  commit(message) {
    if (typeof message !== "string" || !message.trim()) throw new ReviewError("commit message is empty");
    const r = this._require(APPROVED);
    if (!r.commitRequested) throw new ReviewError("the reviewer did not ask to commit", 409);
    this._checkCommitTarget(r);
    const approved = this.git.out(["rev-parse", r.rounds.at(-1).commit + "^{tree}"]);
    if (this._worktreeTree() !== approved) {
      throw new ReviewError("working tree differs from the approved snapshot; nothing committed", 409);
    }
    let line;
    if (approved === this.git.out(["rev-parse", "HEAD^{tree}"])) {
      line = `nothing to commit; ${r.branch} already matches the approved snapshot`;
    } else {
      const sha = this._gitCommit(r, message.trim() + "\n", approved);
      line = `committed ${sha.slice(0, 7)} on ${r.branch}`;
      r.committed = sha;
      delete r.commitError;
    }
    this.lastResult = line;
    this._archive(r);
    return line;
  }

  _gitCommit(r, message, approved) {
    const index = path.resolve(this.repo.top, this.git.out(["rev-parse", "--git-path", "index"]));
    const backup = fs.existsSync(index) ? fs.readFileSync(index) : null;
    const msgPath = path.join(this.stateDir, "COMMIT_MSG");
    writeFileSafe(msgPath, message);
    try {
      this.git.run(["add", "-A"]);
      if (this.git.out(["write-tree"]) !== approved) {
        throw new ReviewError("working tree changed during commit; nothing committed", 409);
      }
      this.git.run(["commit", "-q", "--cleanup=strip", "-F", msgPath], { env: { GIT_EDITOR: "true" } });
    } catch (e) {
      if (!(e instanceof ReviewError)) throw e;
      // Put the user's index back exactly as it was.
      if (backup === null) unlinkQuiet(index);
      else writeFileSafe(index, backup);
      r.commitError = e.message;
      this._commit(r);
      throw new ReviewError("commit failed: " + e.message, 409);
    } finally {
      unlinkQuiet(msgPath);
    }
    return this.git.out(["rev-parse", "HEAD"]);
  }

  /** `gone()` reports that the caller has disconnected: stop without consuming. */
  async wait(timeout, gone = () => false) {
    const deadline = Date.now() + timeout * 1000;
    const rid = this._require().id;
    for (;;) {
      if (this.review === null || this.review.id !== rid) return "ENDED";
      const r = structuredClone(this.review);
      const n = r.rounds.length;
      if ((r.status === CHANGES || r.status === APPROVED) && r.consumed < n && !gone()) {
        const text = formatWait(r);
        r.consumed = n;
        this._commit(r);
        return text;
      }
      if (this.closing) return "STOPPED";
      const remaining = deadline - Date.now();
      if (remaining <= 0 || gone()) return "TIMEOUT";
      await this._changed(remaining);
    }
  }

  openUrl() {
    const r = this._require();
    return `${r.id} ${this.url}`;
  }

  push(text) {
    const r = this._require(CHANGES);
    const entries = parsePush(text);
    const byId = new Map(r.comments.filter((c) => c.state !== "draft").map((c) => [c.id, c]));
    for (const [cid] of entries) {
      if (!byId.has(cid)) throw new ReviewError(`unknown comment #${cid}`);
    }
    const needed = attention(r).map(([c]) => c.id);
    const n = r.rounds.length + 1;
    for (const [cid, action, msg] of entries) {
      const c = byId.get(cid);
      if (msg) c.thread.push({ author: "claude", body: msg, round: n, at: nowIso() });
      if (action === "resolve" && c.state === "open") c.state = "resolved";
      else if (action === "reply" && c.state === "resolved") c.state = "open";
    }
    const prev = r.rounds.at(-1).commit;
    const [commit] = this._snapshot(r.id, n, r.base);
    r.rounds.push({ n, commit, createdAt: nowIso() });
    this._relocate(r, prev, commit);
    r.status = PENDING;
    this._commit(r);
    const mentioned = new Set(entries.map(([cid]) => cid));
    const unanswered = needed.filter((cid) => !mentioned.has(cid));
    let line = `round ${n} ok`;
    if (unanswered.length) line += "; unanswered: " + unanswered.map((cid) => "#" + cid).join(" ");
    return line;
  }

  _relocate(r, prevCommit, newCommit) {
    const files = new Map(this._diff(r.base, newCommit).map((f) => [f.path, f]));
    const renames = new Map(this._diff(prevCommit, newCommit).filter((f) => f.status === "R")
      .map((f) => [f.oldPath, f.path]));
    const sameAnchor = (a, b) => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
    for (const c of r.comments) {
      if (c.state !== "open" && c.state !== "resolved") continue;
      if (c.side === "old") {
        // The base is fixed: the lines must still be shown as deleted.
        if (!sameAnchor(collectRange(files.get(c.path), "old", c.start, c.end), c.anchor)) c.state = "outdated";
        continue;
      }
      const p = renames.has(c.path) ? renames.get(c.path) : c.path;
      const lines = this._fileLines(newCommit, p);
      const start = lines !== null ? findAnchor(lines, c.anchor, c.start) : null;
      if (start === null) {
        c.state = "outdated";
        continue;
      }
      const end = start + c.anchor.length - 1;
      if (collectRange(files.get(p), "new", start, end) === null) {
        // Still in the file, but no longer visible in the diff.
        c.state = "outdated";
        continue;
      }
      c.path = p;
      c.start = start;
      c.end = end;
    }
  }

  // -- UI operations

  payload() {
    return { version: this.version, review: this.review, lastResult: this.lastResult };
  }

  async events(version, timeout = EVENTS_TIMEOUT) {
    const deadline = Date.now() + timeout * 1000;
    while (this.version === version && !this.closing) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this._changed(remaining);
    }
    return { version: this.version };
  }

  diff(roundNo = null, since = null) {
    const r = this._require();
    const rounds = r.rounds;
    const n = roundNo === null ? rounds.length : roundNo;
    if (!(n >= 1 && n <= rounds.length)) throw new ReviewError("unknown round");
    if (since !== null && !(since >= 1 && since < n)) throw new ReviewError("invalid since round");
    const a = since ? rounds[since - 1].commit : r.base;
    return { round: n, since, files: this._diff(a, rounds[n - 1].commit) };
  }

  _latestFile(r, p) {
    const f = this._diff(r.base, r.rounds.at(-1).commit).find((x) => x.path === p);
    if (!f) throw new ReviewError("path is not in the diff");
    return f;
  }

  _find(r, cid) {
    const c = r.comments.find((x) => x.id === cid);
    if (!c) throw new ReviewError("unknown comment", 404);
    return c;
  }

  addComment(body) {
    const { path: p, side, start, end } = body;
    const text = checkBody(body.body);
    if (typeof p !== "string" || (side !== "new" && side !== "old")) throw new ReviewError("invalid comment");
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new ReviewError("invalid line range");
    const r = this._require(PENDING);
    const anchor = collectRange(this._latestFile(r, p), side, start, end);
    if (anchor === null) throw new ReviewError("invalid line range");
    const n = r.rounds.length;
    const c = {
      id: r.nextCommentId, round: n, path: p, side, start, end, anchor, state: "draft",
      thread: [{ author: "user", body: text, round: n, at: nowIso() }],
    };
    r.nextCommentId += 1;
    r.comments.push(c);
    this._commit(r);
    return c;
  }

  editComment(cid, body) {
    const r = this._require(PENDING);
    const c = this._find(r, cid);
    if (Object.hasOwn(body, "body")) {
      if (c.state !== "draft") throw new ReviewError("only drafts can be edited", 409);
      c.thread[0].body = checkBody(body.body);
    }
    if (Object.hasOwn(body, "state")) {
      const ok = (s) => s === "open" || s === "resolved";
      if (!ok(body.state) || !ok(c.state)) throw new ReviewError("invalid state change", 409);
      c.state = body.state;
    }
    this._commit(r);
    return c;
  }

  deleteComment(cid) {
    const r = this._require(PENDING);
    const c = this._find(r, cid);
    if (c.state !== "draft") throw new ReviewError("only drafts can be deleted", 409);
    r.comments.splice(r.comments.indexOf(c), 1);
    this._commit(r);
    return { ok: true };
  }

  addReply(cid, body) {
    const text = checkBody(body.body);
    const r = this._require(PENDING);
    const c = this._find(r, cid);
    if (c.state === "draft") throw new ReviewError("cannot reply to a draft", 409);
    c.thread.push({ author: "user", body: text, round: r.rounds.length, at: nowIso(), draft: true });
    this._commit(r);
    return c;
  }

  _draftReply(c, idx) {
    if (!(idx > 0 && idx < c.thread.length) || !c.thread[idx].draft) {
      throw new ReviewError("unknown draft reply", 404);
    }
    return c.thread[idx];
  }

  editReply(cid, idx, body) {
    const r = this._require(PENDING);
    const c = this._find(r, cid);
    this._draftReply(c, idx).body = checkBody(body.body);
    this._commit(r);
    return c;
  }

  deleteReply(cid, idx) {
    const r = this._require(PENDING);
    const c = this._find(r, cid);
    this._draftReply(c, idx);
    c.thread.splice(idx, 1);
    this._commit(r);
    return c;
  }

  submit(body) {
    const verdict = body.verdict;
    let summary = body.summary || "";
    if (!["request_changes", "approve", "approve_commit"].includes(verdict) || typeof summary !== "string") {
      throw new ReviewError("invalid verdict");
    }
    summary = summary.trim();
    const r = this._require(PENDING);
    if (verdict === "approve_commit") {
      this._checkCommitTarget(r); // fail now, not after Claude writes a message
      r.commitRequested = true;
    }
    const n = r.rounds.length;
    for (const c of r.comments) {
      if (c.state === "draft") {
        c.state = "open";
        for (const e of c.thread) e.round = n;
      }
      for (const e of c.thread) {
        if (e.draft) e.round = n;
        delete e.draft;
      }
    }
    if (summary) r.summaries.push({ round: n, body: summary });
    if (verdict === "request_changes" && !summary && !attention(r).length) {
      throw new ReviewError("Request changes needs at least one comment or a summary");
    }
    r.status = verdict === "request_changes" ? CHANGES : APPROVED;
    this._commit(r);
    return { status: r.status };
  }
}

export function checkBody(text) {
  if (typeof text !== "string" || !text.trim()) throw new ReviewError("comment body is empty");
  if (Array.from(text).length > MAX_COMMENT) throw new ReviewError("comment is too long");
  return text.trimEnd();
}
