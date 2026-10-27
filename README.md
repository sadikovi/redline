# redline

A local, GitHub-style code review loop for Claude Code. Claude makes changes, opens a
"Files changed" page in your browser, waits for you to submit a review, addresses your
comments, pushes a new round, and repeats until you approve. You commit, or choose
**Approve and commit** and Claude commits the approved changes for you.

- Node.js 22+ with a handful of npm packages (Express, Commander); plain HTML/CSS/JS UI with
  highlight.js syntax highlighting, no build step.
- Never commits, stages or touches your index unless you choose **Approve and commit**.
  Snapshots use a temporary index and `refs/redline/*`, which are cleaned up automatically.
- Binds to `127.0.0.1` only, with a per-server token, `Host`/`Origin` checks and a strict CSP.

See [`redline-spec.md`](redline-spec.md) for the full design.

## Install

```sh
npm install
mkdir -p ~/.claude/commands
cp commands/redline.md ~/.claude/commands/
```

The slash command runs the CLI as `node /Users/ivansadikov/Developer/redline/bin/redline.js`,
so nothing needs to be on `PATH`. If you clone the repo elsewhere, update that path in
`commands/redline.md` (both the `allowed-tools` line and the `REVIEW` definition).
To type `redline` by hand, put it on `PATH` with `npm link`.

## Use

In Claude Code, after Claude has made some changes:

```
/redline            # review uncommitted changes against HEAD (or resume the current review)
/redline main       # review the whole branch since main, plus uncommitted work
/redline new [ref]  # discard the unfinished review and start a fresh one
/redline status     # one-line state
/redline open       # reopen the review page (fresh URL after a server restart)
/redline pause      # stop the server and Claude's wait; /redline resumes later
/redline stop       # end the review (archive it, delete its refs) and stop the server
```

Comment on lines in the browser (click the blue **+**, drag or shift-click for ranges),
then **Finish your review** → **Request changes** or **Approve**. Claude is notified,
replies to each comment and pushes the next round. "Changes since round K" shows only
what changed in response.

Keyboard: `j`/`k` next/previous file, `n` next open thread, `v` toggle viewed.

## CLI

| Command | Purpose |
|---|---|
| `redline start [<ref>] [--title T] [--no-open] [--new]` | Start (or resume) a review and open the page |
| `redline wait [--timeout S]` | Block until the reviewer submits (exit 2 on timeout); prints `STOPPED`/`ENDED` if the server is stopped or the review ended |
| `redline push` | Read `#<id> resolve: …` / `#<id> reply: …` lines from stdin; snapshot the next round |
| `redline commit` | After "Approve and commit": commit the approved snapshot with the message from stdin |
| `redline status` | One-line state |
| `redline open` | Open the current review page in the browser |
| `redline end` | Archive the review and delete its refs |
| `redline stop` | Stop the server |
| `redline serve` | Run the server in the foreground (debugging); `npm start` does the same |

`npm start` runs the server in the foreground for the repository you run it from (the
redline checkout itself, or any repo via `npm --prefix /path/to/redline start`).
Other `redline` commands use that server while it runs; Ctrl-C stops it.

State lives in `<git-dir>/redline/`. Server errors are logged to `server.log` there.

## Behaviour notes

- Comments can only be added on the latest round in the "All changes" view; older rounds and
  the "Changes since" view are read-only.
- Reviewer actions are only accepted while the review is waiting for the reviewer
  (`pending_review`); the page is read-only while Claude works and after approval.
- On a new round, open and resolved comments are relocated by exact text match. A comment
  becomes outdated if its lines changed, its file was deleted, or its lines are no longer
  visible in the diff.
- `redline start` with nothing to review exits with `error: no changes to review`.
- If the server dies, the next `redline` command starts a new one (new port and token);
  run `redline start --no-open` for the new URL.

## Approve and commit

Choosing **Approve and commit** makes `redline wait` return `APPROVED round=N commit=requested`.
Claude writes a commit message from its changes and the branch's recent commits, then runs
`redline commit` with it on stdin. The commit:

- goes on the branch that was checked out when the review started, and only if that branch is
  still checked out at the same commit (checked again when you submit);
- contains exactly the approved snapshot: if the working tree changed after approval, nothing
  is committed;
- uses a real `git commit`, so your hooks, signing and identity apply. If it fails (for example
  a pre-commit hook), your index is restored, the page shows the error, and the review stays
  approved so the commit can be retried.

On success the review is archived and the page shows `Approved · committed <sha> on <branch>`.

## Tests

```sh
npm test
```
