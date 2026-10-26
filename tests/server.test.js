// End-to-end tests through the real CLI and a detached server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { TempRepo, lines, pidAlive, sleep } from "./helpers.js";

let repo, startLine;

function setUp() {
  beforeEach(() => {
    repo = new TempRepo();
    repo.write("a.txt", lines(10));
    repo.commit();
    repo.write("a.txt", lines(10).replace("line 3\n", "three\n"));
    const p = repo.cli(["start", "--no-open"]);
    assert.equal(p.returncode, 0, p.stderr);
    startLine = p.stdout.trim();
  });
  afterEach(() => {
    repo.stop();
    repo.cleanup();
  });
}

async function comment(start = 3, body = "please fix") {
  const [status, c] = await repo.http("POST", "/api/comments",
    { body: { path: "a.txt", side: "new", start, end: start, body } });
  assert.equal(status, 200, JSON.stringify(c));
  return c;
}

async function submit(verdict = "request_changes") {
  const [status, body] = await repo.http("POST", "/api/submit", { body: { verdict } });
  assert.equal(status, 200, JSON.stringify(body));
}

/** `review wait` in the background, checked to be blocking. */
async function backgroundWait() {
  const proc = repo.spawnCli(["wait", "--timeout", "30"]);
  await sleep(1000);
  assert.equal(proc.exitCode, null);
  return proc;
}

const stateFile = (name) => path.join(repo.dir, ".git", "local-review", name);

describe("cli", () => {
  setUp();

  test("start output and status", () => {
    const info = repo.serverInfo();
    assert.match(startLine, new RegExp(`^review [0-9a-f]{6} round 1 http://127\\.0\\.0\\.1:${info.port}/#t=${info.token}$`));
    assert.equal(fs.statSync(stateFile("server.json")).mode & 0o777, 0o600);
    assert.match(repo.cli(["status"]).stdout, /^[0-9a-f]{6} round 1 pending_review open=0\n$/);
  });

  test("full round trip", async () => {
    await comment();
    await submit();
    let p = repo.cli(["wait", "--timeout", "5"]);
    assert.equal(p.returncode, 0);
    assert.ok(p.stdout.startsWith("CHANGES_REQUESTED round=1 comments=1\n#1 a.txt:+3\n> three\n"), p.stdout);
    repo.write("a.txt", lines(10).replace("line 3\n", "THREE\n"));
    p = repo.cli(["push"], { input: "#1 resolve: Uppercased.\n" });
    assert.deepEqual([p.returncode, p.stdout], [0, "round 2 ok\n"], p.stderr);
    const [status, data] = await repo.http("GET", "/api/diff?round=2&since=1");
    assert.equal(status, 200);
    assert.deepEqual(data.files[0].hunks[0].lines.filter((l) => l.type !== "ctx").map((l) => l.text), ["three", "THREE"]);
    await submit("approve");
    p = repo.cli(["wait", "--timeout", "5"]);
    assert.equal(p.stdout, "APPROVED round=2\n");
    assert.equal(repo.git("diff", "--cached", "--name-only"), "");
  });

  test("wait timeout exit code", () => {
    const p = repo.cli(["wait", "--timeout", "1"]);
    assert.deepEqual([p.returncode, p.stdout], [2, "TIMEOUT\n"]);
  });

  test("errors are one line", () => {
    const p = repo.cli(["push"], { input: "#1 resolve\n" });
    assert.equal(p.returncode, 1);
    assert.equal(p.stdout, "");
    assert.equal(p.stderr.trim().split("\n").length, 1);
  });

  test("end", () => {
    const rid = startLine.split(" ")[1];
    assert.equal(repo.cli(["end"]).stdout, `ended ${rid}\n`);
    assert.equal(repo.git("for-each-ref", "refs/local-review"), "");
    assert.ok(fs.existsSync(stateFile(path.join("archive", rid + ".json"))));
  });
});

describe("stop and end", () => {
  setUp();

  test("wait reports STOPPED and the server stays down", async () => {
    const proc = await backgroundWait();
    const pid = repo.serverInfo().pid;
    assert.equal(repo.cli(["stop"]).stdout, "stopped\n");
    assert.deepEqual(await proc.done, { returncode: 0, stdout: "STOPPED\n" });
    await sleep(500);
    assert.ok(!fs.existsSync(stateFile("server.json")));
    assert.ok(!pidAlive(pid));
    // Paused, not ended: the next start resumes.
    assert.match(repo.cli(["start", "--no-open"]).stdout, /^resumed /);
  });

  test("wait reports ENDED", async () => {
    const proc = await backgroundWait();
    repo.cli(["end"]);
    assert.equal((await proc.done).stdout, "ENDED\n");
  });

  test("wait reports ENDED on --new", async () => {
    const proc = await backgroundWait();
    assert.match(repo.cli(["start", "--no-open", "--new"]).stdout, /^review /);
    assert.equal((await proc.done).stdout, "ENDED\n");
  });

  test("a killed wait does not consume the next submission", async () => {
    const proc = await backgroundWait();
    proc.kill("SIGKILL");
    await proc.done;
    await comment();
    await submit();
    assert.match(repo.cli(["wait", "--timeout", "5"]).stdout, /^CHANGES_REQUESTED round=1 comments=1\n/);
  });

  test("open url", async () => {
    const rid = startLine.split(" ")[1];
    // `open` launches a browser; check the endpoint behind it instead.
    assert.deepEqual(await repo.http("GET", "/api/url"), [200, `${rid} ${startLine.split(" ").at(-1)}`]);
    repo.cli(["end"]);
    assert.equal((await repo.http("GET", "/api/url"))[0], 404);
  });
});

describe("security", () => {
  setUp();

  test("token required", async () => {
    assert.equal((await repo.http("GET", "/api/review", { token: false }))[0], 401);
    assert.equal((await repo.http("GET", "/api/review", { headers: { Authorization: "Bearer nope" } }))[0], 401);
    assert.equal((await repo.http("GET", "/api/review"))[0], 200);
  });

  test("foreign host", async () => {
    assert.equal((await repo.http("GET", "/api/review", { headers: { Host: "evil.example:80" } }))[0], 403);
    assert.equal((await repo.http("GET", "/", { headers: { Host: "evil.example" } }))[0], 403);
  });

  test("foreign origin on POST", async () => {
    const body = { path: "a.txt", side: "new", start: 3, end: 3, body: "x" };
    assert.equal((await repo.http("POST", "/api/comments", { body, headers: { Origin: "http://evil.example" } }))[0], 403);
    const port = repo.serverInfo().port;
    assert.equal((await repo.http("POST", "/api/comments", { body, headers: { Origin: `http://localhost:${port}` } }))[0], 200);
  });

  test("non-JSON POST", async () => {
    const [status] = await repo.http("POST", "/api/submit", { raw: "verdict=approve",
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(status, 415);
  });

  test("static files need no token", async () => {
    const [status, body] = await repo.http("GET", "/", { token: false });
    assert.equal(status, 200);
    assert.ok(body.includes("<title>"));
  });

  test("highlight.js is served from node_modules", async () => {
    const [status, body] = await repo.http("GET", "/vendor/highlight.min.js", { token: false });
    assert.equal(status, 200);
    assert.ok(body.includes("hljs"));
    assert.equal((await repo.http("GET", "/vendor/other.js", { token: false }))[0], 404);
  });

  test("invalid comment path rejected", async () => {
    const [status] = await repo.http("POST", "/api/comments",
      { body: { path: "../etc/passwd", side: "new", start: 1, end: 1, body: "x" } });
    assert.equal(status, 400);
  });
});

describe("concurrency", () => {
  setUp();

  test("wait wakes within a second", async () => {
    await comment();
    const proc = await backgroundWait();
    const t0 = Date.now();
    await submit();
    const out = await proc.done;
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(out.stdout.startsWith("CHANGES_REQUESTED round=1 comments=1"));
  });
});

describe("recovery", () => {
  setUp();

  test("server killed mid-review", async () => {
    await comment(3, "draft survives");
    const old = repo.serverInfo();
    process.kill(old.pid, "SIGKILL");
    await sleep(200);
    const p = repo.cli(["status"]);
    assert.equal(p.returncode, 0, p.stderr);
    const fresh = repo.serverInfo();
    assert.notEqual(fresh.pid, old.pid);
    assert.notEqual(fresh.token, old.token);
    const [status, data] = await repo.http("GET", "/api/review");
    assert.equal(status, 200);
    assert.deepEqual(data.review.comments.map((c) => [c.state, c.thread[0].body]), [["draft", "draft survives"]]);
  });

  test("consumed without push is redelivered", async () => {
    await comment();
    await submit();
    const first = repo.cli(["wait", "--timeout", "5"]).stdout;
    assert.equal(repo.cli(["wait", "--timeout", "1"]).stdout, "TIMEOUT\n");
    assert.match(repo.cli(["start", "--no-open"]).stdout,
      /^resumed [0-9a-f]{6} round 1 changes_requested comments=1 http:\/\//);
    assert.equal(repo.cli(["wait", "--timeout", "5"]).stdout, first);
  });

  test("resume pending", () => {
    assert.match(repo.cli(["start", "--no-open"]).stdout, /^resumed [0-9a-f]{6} round 1 pending_review http:\/\//);
  });
});

describe("cleanup", () => {
  setUp();

  const refs = () => repo.git("for-each-ref", "--format=%(refname)", "refs/local-review").split(/\s+/).filter(Boolean);

  test("start after approval removes old and orphaned refs", async () => {
    const oldId = startLine.split(" ")[1];
    repo.git("update-ref", "refs/local-review/dead00/round-1", "HEAD");
    await submit("approve");
    repo.write("a.txt", lines(10).replace("line 4\n", "four\n"));
    const p = repo.cli(["start", "--no-open"]);
    assert.match(p.stdout, /^review [0-9a-f]{6} round 1 /);
    const newId = p.stdout.split(" ")[1];
    assert.notEqual(newId, oldId);
    assert.deepEqual(refs(), [`refs/local-review/${newId}/round-1`]);
  });

  test("start --new discards", () => {
    assert.match(repo.cli(["start", "--no-open", "--new"]).stdout, /^review /);
    assert.equal(refs().length, 1);
  });
});
