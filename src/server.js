import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Core, DEFAULT_WAIT } from "./core.js";
import { PENDING } from "./format.js";
import { ReviewError, readJson, unlinkQuiet, writeJson } from "./util.js";

const UI_DIR = path.join(import.meta.dirname, "..", "ui");
const HIGHLIGHT_JS = fileURLToPath(import.meta.resolve("@highlightjs/cdn-assets/highlight.min.js"));
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const IDLE_SHUTDOWN = 2 * 3600 * 1000;
const MAX_REQUEST = 4 << 20;

function queryInt(req, name, dflt = null) {
  const v = req.query[name];
  if (v === undefined || v === "") return dflt;
  if (typeof v !== "string" || !/^\s*[+-]?\d+\s*$/.test(v)) throw new ReviewError(`invalid ${name}`);
  return parseInt(v, 10);
}

function paramInt(req, name) {
  if (!/^\d+$/.test(req.params[name])) throw new ReviewError("not found", 404);
  return parseInt(req.params[name], 10);
}

const text = (res, s) => res.type("text/plain").send(s);

/** True once the caller has gone away; also wakes long-polls so they can notice. */
function disconnected(req, res, core) {
  let closed = false;
  res.on("close", () => {
    closed = true;
    core.wake();
  });
  return () => closed;
}

/** `hosts` may be filled in after creation, once the port is known. */
export function createApp(core, { token, hosts, onShutdown }) {
  const want = Buffer.from(`Bearer ${token}`);
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");

  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (!hosts.includes(req.headers.host ?? "")) throw new ReviewError("forbidden host", 403);
    next();
  });

  const staticOpts = {
    etag: false, lastModified: false, dotfiles: "deny",
    setHeaders: (res) => res.set("Content-Security-Policy", CSP),
  };
  app.use(express.static(UI_DIR, staticOpts));
  app.get("/vendor/highlight.min.js", (req, res) =>
    res.set("Content-Security-Policy", CSP).sendFile(HIGHLIGHT_JS, { lastModified: false }));

  const api = express.Router();
  api.use((req, res, next) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== want.length || !crypto.timingSafeEqual(auth, want)) {
      throw new ReviewError("unauthorized", 401);
    }
    core.lastRequest = Date.now();
    const { origin } = req.headers;
    if (req.method !== "GET" && origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      throw new ReviewError("forbidden origin", 403);
    }
    const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if ((req.method === "POST" || req.method === "PATCH") && ctype !== "application/json") {
      throw new ReviewError("expected application/json", 415);
    }
    next();
  });
  api.use(express.json({ limit: MAX_REQUEST }));
  api.use((req, res, next) => {
    req.body ??= {};
    if (typeof req.body !== "object" || Array.isArray(req.body)) throw new ReviewError("expected an object");
    next();
  });

  api.get("/ping", (req, res) => res.json({ ok: true }));
  api.get("/review", (req, res) => res.json(core.payload()));
  api.get("/diff", (req, res) => res.json(core.diff(queryInt(req, "round"), queryInt(req, "since"))));
  api.get("/events", async (req, res) => res.json(await core.events(queryInt(req, "version", 0))));
  api.get("/wait", async (req, res) => {
    const timeout = Math.min(Math.max(queryInt(req, "timeout", DEFAULT_WAIT), 0), 86400);
    text(res, await core.wait(timeout, disconnected(req, res, core)));
  });
  api.get("/status", (req, res) => text(res, core.status()));
  api.get("/url", (req, res) => text(res, core.openUrl()));

  api.post("/comments", (req, res) => res.json(core.addComment(req.body)));
  api.patch("/comments/:id", (req, res) => res.json(core.editComment(paramInt(req, "id"), req.body)));
  api.delete("/comments/:id", (req, res) => res.json(core.deleteComment(paramInt(req, "id"))));
  api.post("/comments/:id/replies", (req, res) => res.json(core.addReply(paramInt(req, "id"), req.body)));
  api.patch("/comments/:id/replies/:idx", (req, res) =>
    res.json(core.editReply(paramInt(req, "id"), paramInt(req, "idx"), req.body)));
  api.delete("/comments/:id/replies/:idx", (req, res) =>
    res.json(core.deleteReply(paramInt(req, "id"), paramInt(req, "idx"))));
  api.post("/submit", (req, res) => res.json(core.submit(req.body)));

  api.post("/start", (req, res) => {
    const { ref, title } = req.body;
    text(res, core.start(ref || null, title || null, Boolean(req.body.new)));
  });
  api.post("/push", (req, res) => {
    if (typeof req.body.text !== "string") throw new ReviewError("missing text");
    text(res, core.push(req.body.text));
  });
  api.post("/commit", (req, res) => text(res, core.commit(req.body.message)));
  api.post("/end", (req, res) => text(res, core.end()));
  api.post("/shutdown", (req, res) => {
    text(res, "stopped");
    onShutdown();
  });

  app.use("/api", api);
  app.use(() => {
    throw new ReviewError("not found", 404);
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return;
    if (err instanceof ReviewError) return res.status(err.code).json({ error: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "request too large" });
    if (err.type === "entity.parse.failed" || err.type === "encoding.unsupported") {
      return res.status(400).json({ error: "invalid JSON" });
    }
    res.status(500).json({ error: `internal error: ${err.message}` });
  });
  return app;
}

/** Run the server for `repo` until it is stopped, idle for too long, or signalled. */
export async function serve(repo) {
  fs.mkdirSync(repo.stateDir, { recursive: true, mode: 0o700 });
  const core = new Core(repo);
  const token = crypto.randomBytes(32).toString("base64url");
  const infoPath = path.join(repo.stateDir, "server.json");

  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  let stopping = false;
  const stopSoon = () => {
    if (stopping) return;
    stopping = true;
    core.close(); // wakes long-polls, e.g. `wait` -> STOPPED
    setTimeout(stop, 300); // ...and gives them time to respond
  };

  const hosts = [];
  const server = createApp(core, { token, hosts, onShutdown: stopSoon }).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => server.once("listening", resolve).once("error", reject));
  const { port } = server.address();
  hosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  core.url = `http://127.0.0.1:${port}/#t=${token}`;
  writeJson(infoPath, { pid: process.pid, port, token });
  console.log(`local-review serving ${repo.top} on http://127.0.0.1:${port}/ (run \`review open\` for the page)`);

  process.on("SIGTERM", stopSoon);
  process.on("SIGINT", stopSoon);
  const idle = setInterval(() => {
    const busy = core.review?.status === PENDING;
    if (!busy && Date.now() - core.lastRequest > IDLE_SHUTDOWN) stopSoon();
  }, 60_000);

  await stopped;
  clearInterval(idle);
  if (readJson(infoPath)?.pid === process.pid) unlinkQuiet(infoPath);
  server.close();
  server.closeAllConnections();
}
