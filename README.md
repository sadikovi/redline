# local-review

A local, GitHub-style code review loop for Claude Code. Claude makes changes, opens a
"Files changed" page in your browser, waits for you to submit a review, addresses your
comments, pushes a new round, and repeats until you approve. You commit.

- Python 3.9+ standard library only; plain HTML/CSS/JS UI. No build step, no dependencies.
- Never commits, stages or touches your index. Snapshots use a temporary index and
  `refs/local-review/*`, which are cleaned up automatically.
- Binds to `127.0.0.1` only, with a per-server token, `Host`/`Origin` checks and a strict CSP.

See [`local-review-spec.md`](local-review-spec.md) for the full design.

## Install

```sh
mkdir -p ~/.claude/commands
cp commands/local-review.md ~/.claude/commands/
```

The slash command runs the script as `python3 /Users/ivansadikov/Developer/local-review/review`,
so nothing needs to be on `PATH`. If you clone the repo elsewhere, update that path in
`commands/local-review.md` (both the `allowed-tools` line and the `REVIEW` definition).
To type `review` by hand, optionally symlink it: `ln -s "$PWD/review" ~/.local/bin/review`.

## Use

In Claude Code, after Claude has made some changes:

```
/local-review            # review uncommitted changes against HEAD
/local-review main       # review the whole branch since main, plus uncommitted work
```

Comment on lines in the browser (click the blue **+**, drag or shift-click for ranges),
then **Finish your review** → **Request changes** or **Approve**. Claude is notified,
replies to each comment and pushes the next round. "Changes since round K" shows only
what changed in response.

Keyboard: `j`/`k` next/previous file, `n` next open thread, `v` toggle viewed.

## CLI

| Command | Purpose |
|---|---|
| `review start [<ref>] [--title T] [--no-open] [--new]` | Start (or resume) a review and open the page |
| `review wait [--timeout S]` | Block until the reviewer submits (exit 2 on timeout) |
| `review push` | Read `#<id> resolve: …` / `#<id> reply: …` lines from stdin; snapshot the next round |
| `review status` | One-line state |
| `review end` | Archive the review and delete its refs |
| `review stop` | Stop the server |
| `review serve` | Run the server in the foreground (debugging) |

State lives in `<git-dir>/local-review/`. Server errors are logged to `server.log` there.

## Behaviour notes

- Comments can only be added on the latest round in the "All changes" view; older rounds and
  the "Changes since" view are read-only.
- Reviewer actions are only accepted while the review is waiting for the reviewer
  (`pending_review`); the page is read-only while Claude works and after approval.
- On a new round, open and resolved comments are relocated by exact text match. A comment
  becomes outdated if its lines changed, its file was deleted, or its lines are no longer
  visible in the diff.
- `review start` with nothing to review exits with `error: no changes to review`.
- If the server dies, the next `review` command starts a new one (new port and token);
  run `review start --no-open` for the new URL.

## Tests

```sh
python3 -m unittest discover -s tests
```
