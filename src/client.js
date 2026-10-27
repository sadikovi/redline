import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { ReviewError, readJson, sleep } from "./util.js";

const BIN = path.join(import.meta.dirname, "..", "bin", "redline.js");
// Undici (fetch) gives up waiting for response headers after 300 s, so long waits are chunked.
const MAX_WAIT_CHUNK = 240;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Rejects with a plain Error (not a ReviewError) when the server cannot be reached. */
async function request(info, method, p, body, timeout) {
  const init = { method, headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(timeout * 1000) };
  if (method === "POST" || method === "PATCH") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`http://127.0.0.1:${info.port}${p}`, init);
  const data = (res.headers.get("content-type") ?? "").startsWith("application/json") ? await res.json() : await res.text();
  return [res.status, data];
}

export class Client {
  constructor(repo) {
    this.repo = repo;
    this.infoPath = path.join(repo.stateDir, "server.json");
    this.info = null;
  }

  async _responding(info) {
    if (!pidAlive(info?.pid)) return false;
    try {
      return (await request(info, "GET", "/api/ping", null, 3))[0] === 200;
    } catch {
      return false;
    }
  }

  async running() {
    const info = readJson(this.infoPath);
    return (await this._responding(info)) ? info : null;
  }

  /** Return server info, starting a detached server if none is responding. */
  async ensure() {
    const { stateDir } = this.repo;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(stateDir, {
      lockfilePath: path.join(stateDir, "server-start.lock"),
      retries: { retries: 300, minTimeout: 50, maxTimeout: 100 },
    });
    try {
      let info = await this.running();
      if (info) return (this.info = info);
      const logPath = path.join(stateDir, "server.log");
      const log = fs.openSync(logPath, "a");
      const proc = spawn(process.execPath, [BIN, "serve"], {
        cwd: this.repo.top, stdio: ["ignore", "ignore", log], detached: true,
      });
      fs.closeSync(log);
      proc.on("error", () => {});
      proc.unref();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
        info = readJson(this.infoPath);
        if (info?.pid === proc.pid && (await this._responding(info))) return (this.info = info);
        await sleep(50);
      }
      throw new ReviewError(`server failed to start (see ${logPath})`);
    } finally {
      await release();
    }
  }

  async call(method, p, body = null, { timeout = 60, retry = true } = {}) {
    let info = this.info ?? (await this.ensure());
    let status, data;
    try {
      [status, data] = await request(info, method, p, body, timeout);
    } catch (e) {
      if (!retry) throw e;
      this.info = null;
      info = await this.ensure();
      [status, data] = await request(info, method, p, body, timeout);
    }
    if (status >= 400) throw new ReviewError((typeof data === "object" ? data?.error : data) || `HTTP ${status}`);
    return data;
  }

  /** Block until the reviewer submits; restarts the server if it dies meanwhile. */
  async wait(timeout) {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      const chunk = Math.min(remaining, MAX_WAIT_CHUNK);
      try {
        const out = await this.call("GET", `/api/wait?timeout=${chunk}`, null, { timeout: chunk + 30, retry: false });
        if (out !== "TIMEOUT" || chunk === remaining) return out;
      } catch (e) {
        if (e instanceof ReviewError) throw e;
        if (Date.now() >= deadline) return "TIMEOUT";
        this.info = null;
        await sleep(200);
        await this.ensure();
      }
    }
  }

  async stop() {
    const info = await this.running();
    if (info) {
      await request(info, "POST", "/api/shutdown", {}, 5).catch(() => {});
      const deadline = Date.now() + 5000;
      while (pidAlive(info.pid) && Date.now() < deadline) await sleep(50);
    }
    return "stopped";
  }
}
