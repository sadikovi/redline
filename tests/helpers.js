// Shared test helpers: the review modules and throwaway repos.
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core.js";
import * as diff from "../src/diff.js";
import * as format from "../src/format.js";
import { Repo } from "../src/git.js";
import { ReviewError } from "../src/util.js";

export const ROOT = path.dirname(import.meta.dirname);
export const SCRIPT = path.join(ROOT, "bin", "redline.js");
export const GOLDEN = path.join(ROOT, "tests", "golden");
export const review = { ...diff, ...format, Core, Repo, ReviewError };

// Keep the user's git config out of the tests.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = os.devnull;

export class TempRepo {
  constructor() {
    this.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lr-test-")));
    this.git("init", "-q");
    this.git("symbolic-ref", "HEAD", "refs/heads/main");
    this.git("config", "user.name", "Test");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "commit.gpgsign", "false");
  }

  git(...args) {
    return childProcess.execFileSync("git", args, { cwd: this.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  write(p, content) {
    const full = path.join(this.dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  remove(p) {
    fs.unlinkSync(path.join(this.dir, p));
  }

  commit(msg = "commit") {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", msg);
  }

  core() {
    return new review.Core(new review.Repo(this.dir));
  }

  cli(args, { input, timeout = 60 } = {}) {
    const p = childProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: this.dir, input: input || "", encoding: "utf8", timeout: timeout * 1000,
    });
    return { returncode: p.status, stdout: p.stdout, stderr: p.stderr };
  }

  /** Start a CLI command in the background; resolves {returncode, stdout} when it exits. */
  spawnCli(args) {
    const proc = childProcess.spawn(process.execPath, [SCRIPT, ...args], { cwd: this.dir });
    let stdout = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.done = new Promise((resolve) => proc.on("close", (code) => resolve({ returncode: code, stdout })));
    return proc;
  }

  serverInfo() {
    return JSON.parse(fs.readFileSync(path.join(this.dir, ".git", "redline", "server.json"), "utf8"));
  }

  http(method, p, { body, headers, raw, token = true } = {}) {
    const info = this.serverInfo();
    const hdrs = { Connection: "close" };
    if (token) hdrs.Authorization = "Bearer " + info.token;
    let data = raw;
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      hdrs["Content-Type"] = "application/json";
    }
    if (data !== undefined) hdrs["Content-Length"] = Buffer.byteLength(data);
    Object.assign(hdrs, headers);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: info.port, method, path: p, headers: hdrs, agent: false,
        setHost: !("Host" in hdrs) }, (res) => {
        let payload = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { payload += c; });
        res.on("end", () => {
          const ctype = res.headers["content-type"] || "";
          resolve([res.statusCode, ctype.startsWith("application/json") ? JSON.parse(payload) : payload]);
        });
      });
      req.on("error", reject);
      req.end(data);
    });
  }

  stop() {
    try {
      this.cli(["stop"], { timeout: 20 });
    } catch { /* ignore */ }
    try {
      process.kill(this.serverInfo().pid, "SIGKILL");
    } catch { /* not running */ }
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export function lines(n, prefix = "line") {
  let out = "";
  for (let i = 1; i <= n; i++) out += `${prefix} ${i}\n`;
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

