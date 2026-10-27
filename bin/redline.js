#!/usr/bin/env node
// redline: a local, GitHub-style code review loop for Claude Code.
// `redline serve` runs the HTTP server; every other subcommand is a thin HTTP client to it.
import fs from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import open from "open";
import { Client } from "../src/client.js";
import { DEFAULT_WAIT } from "../src/core.js";
import { Repo } from "../src/git.js";
import { serve } from "../src/server.js";

const readStdin = () => fs.readFileSync(0, "utf8");
const openBrowser = (line) => open(line.split(" ").at(-1)).catch(() => {}); // the URL is printed anyway

function seconds(value) {
  if (!/^\s*[+-]?\d+\s*$/.test(value)) throw new InvalidArgumentError("expected whole seconds");
  return Math.max(parseInt(value, 10), 0);
}

/** Wrap an action: print its output, map errors to one line on stderr and exit code 1. */
const run = (fn) => async (...args) => {
  try {
    const out = await fn(new Client(new Repo()), ...args);
    if (out !== undefined) console.log(out);
  } catch (e) {
    console.error(`error: ${String(e.message).replace(/\n/g, " ")}`);
    process.exitCode = 1;
  }
};

const program = new Command("redline").description("Local GitHub-style code review loop.");

program.command("start").description("start or resume a review")
  .argument("[ref]", "review everything since the merge base with this ref")
  .option("--title <title>", "review title")
  .option("--no-open", "do not open the browser")
  .option("--new", "discard the unfinished review and start a fresh one")
  .action(run(async (client, ref, opts) => {
    const out = await client.call("POST", "/api/start", { ref: ref ?? null, title: opts.title ?? null, new: Boolean(opts.new) });
    if (opts.open) await openBrowser(out);
    return out;
  }));

program.command("wait").description("wait for the reviewer to submit (exit 2 on timeout)")
  .option("--timeout <seconds>", "give up after this long", seconds, DEFAULT_WAIT)
  .action(run(async (client, opts) => {
    const out = await client.wait(opts.timeout);
    if (out === "TIMEOUT") process.exitCode = 2;
    return out;
  }));

program.command("push").description("reply to comments (stdin) and push a new round")
  .action(run((client) => client.call("POST", "/api/push", { text: readStdin() }, { timeout: 600 })));

program.command("commit").description("commit the approved snapshot; message from stdin")
  .action(run((client) => client.call("POST", "/api/commit", { message: readStdin() }, { timeout: 600 })));

program.command("status").description("show the current review")
  .action(run((client) => client.call("GET", "/api/status")));

program.command("open").description("open the current review page in the browser")
  .action(run(async (client) => {
    const out = await client.call("GET", "/api/url");
    await openBrowser(out);
    return out;
  }));

program.command("end").description("archive the review and delete its refs")
  .action(run((client) => client.call("POST", "/api/end")));

program.command("stop").description("stop the server")
  .action(run((client) => client.stop()));

program.command("serve").description("run the server in the foreground")
  .action(run(async () => {
    await serve(new Repo());
    process.exit(); // nothing left to flush; don't wait on stray handles
  }));

await program.parseAsync();
