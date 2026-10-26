import { spawnSync } from "node:child_process";
import path from "node:path";
import { ReviewError, splitlines } from "./util.js";

// Synchronous on purpose: each Core operation then runs atomically on the event loop.
function spawnGit(args, opts) {
  const p = spawnSync("git", args, { maxBuffer: 1 << 30, ...opts });
  if (p.error) throw new ReviewError(`git failed: ${p.error.message}`, 500);
  return p;
}

/** Locations for the repository containing `cwd`. */
export class Repo {
  constructor(cwd = process.cwd()) {
    cwd = path.resolve(cwd);
    const p = spawnGit(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], { cwd });
    const lines = splitlines(p.stdout.toString());
    if (p.status !== 0 || lines.length < 3) throw new ReviewError("not inside a git work tree");
    [this.top, this.gitDir] = lines;
    this.commonDir = path.resolve(cwd, lines[2]);
    this.stateDir = path.join(this.gitDir, "local-review");
  }
}

export class Git {
  constructor(cwd) {
    this.cwd = cwd;
  }

  run(args, { env, input, check = true } = {}) {
    const p = spawnGit(args, { cwd: this.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, input });
    if (check && p.status !== 0) {
      const err = splitlines(p.stderr.toString().trim());
      throw new ReviewError(`git failed: ${err.at(-1) ?? args.join(" ")}`, 500);
    }
    return p;
  }

  out(args, opts) {
    return this.run(args, opts).stdout.toString().trim();
  }

  /** Like `out`, but "" instead of an error when git fails. */
  tryOut(args) {
    const p = this.run(args, { check: false });
    return p.status === 0 ? p.stdout.toString().trim() : "";
  }

  verifyCommit(ref) {
    const sha = this.tryOut(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (!sha) throw new ReviewError(`unknown ref: ${ref}`);
    return sha;
  }
}
