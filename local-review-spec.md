# local-review — project spec

A local, GitHub-style code review loop for Claude Code. Claude makes changes, opens a review page in the browser, waits for the reviewer to submit, addresses the comments, pushes a new round and repeats until the reviewer approves. The reviewer then commits.

## 1. Goals and non-goals

### Goals

- A GitHub "Files changed" style UI for the working-tree changes: file list with added/modified/deleted/renamed status, unified diff, line and range comments, threaded replies, "Request changes" and "Approve".
- A review loop driven from a single Claude Code slash command, with Claude notified when the reviewer submits (no polling from Claude's side).
- **Few, well-known dependencies.** Node.js 22+ with Express (HTTP), Commander (CLI), proper-lockfile, write-file-atomic and open; plain HTML, CSS and JavaScript for the UI, plus highlight.js's prebuilt browser bundle (served from `node_modules` at `/vendor/highlight.min.js`). No build step, no CDN.
- **Minimal token use.** Every CLI output Claude reads is compact plain text, designed so Claude never has to read the diff through the tool (it already knows what it changed).
- Local only, safe against other processes and web pages on the same machine.

### Non-goals (v1)

- Multi-user reviews, remote hosting, pushing to GitHub.
- Syntax highlighting, split (side-by-side) view, expanding hidden context. These are phase 2 (see section 11).
- Committing. The tool never commits, stages or modifies the user's real index.

## 2. Workflow

1. The user asks Claude to build something.
2. The user runs `/local-review` (optionally with a base ref, e.g. `/local-review main`).
3. Claude runs `review start`. The server starts if not running, snapshots the changes as round 1 and opens the browser.
4. Claude runs `review wait` **as a background command** and stays free for chat.
5. The user comments in the browser. Comments are drafts until the user clicks **Finish your review** and submits **Request changes** or **Approve**.
6. `review wait` exits, which notifies Claude.
   - `CHANGES_REQUESTED`: Claude addresses each comment, then runs `review push` with one reply per comment in a single call. This records the replies, snapshots round N+1 and refreshes the UI. Claude starts `review wait` in the background again.
   - `APPROVED`: Claude tells the user in one line and stops. It does not commit.
   - `TIMEOUT`: Claude starts `review wait` in the background again, silently.
7. The user commits.

## 3. Architecture

```
local-review/
  bin/review.js       # CLI entry point (commander)
  src/
    core.js           # review state and logic (the single source of truth)
    diff.js           # `git diff` parser, anchors
    format.js         # `review wait` / `review push` text formats
    git.js            # repository locations, git runner
    server.js         # Express app and `serve`
    client.js         # HTTP client, detached server start
    util.js           # errors, atomic JSON files
  ui/
    index.html
    app.js
    app.css
  commands/
    local-review.md   # Claude Code slash command (copy to ~/.claude/commands/)
  tests/
    *.test.js         # node:test
  package.json        # dependencies; `npm start` (foreground server), `npm test`
  README.md
```

- ES modules. `bin/review.js` is the `review` command (`npm link` puts it on `PATH`).
- The server and CLI are the same program. `review serve` runs the HTTP server; every other subcommand is a thin HTTP client to it.
- The server is the single source of truth. The CLI never edits state files directly, so the UI and Claude never disagree.
- One server per repository (per `git rev-parse --git-dir`, so worktrees get separate servers).

### State directory

All state lives in `<git-dir>/local-review/`, so git never tracks it and nothing needs adding to `.gitignore`.

| File | Contents |
|---|---|
| `server.json` | `{"pid", "port", "token"}`; created with mode `0600` |
| `review.json` | Current review: id, title, base commit, rounds, status, comments |
| `index.tmp` | Temporary index used for snapshots |
| `archive/<id>.json` | Finished reviews |

Writes are atomic (write-file-atomic: temp file, `fsync`, rename). All mutations run synchronously on the server's event loop, one at a time.

## 4. Snapshots and diffs

### Taking a snapshot (one per round)

Use a temporary index so the user's real index is never touched:

```
GIT_INDEX_FILE=<state>/index.tmp git read-tree HEAD
GIT_INDEX_FILE=<state>/index.tmp git add -A        # respects .gitignore; includes untracked files
tree=$(GIT_INDEX_FILE=<state>/index.tmp git write-tree)
commit=$(git commit-tree $tree -p <base> -m "local-review <id> round <n>")
git update-ref refs/local-review/<id>/round-<n> $commit
```

The ref protects the snapshot from `git gc`. Delete `refs/local-review/<id>/*` when the review ends.

### Base

- Default base is `HEAD`, resolved to a commit SHA at `review start` and fixed for the review's lifetime.
- `review start <ref>` uses `git merge-base HEAD <ref>`, so `/local-review main` reviews the whole branch plus uncommitted work.

### Diff modes in the UI

- **All changes:** `git diff --no-color --no-ext-diff --find-renames -U3 <base> <round-N>`
- **Changes since round K:** `git diff ... <round-K> <round-N>` (GitHub's "changes since last review"). Comments are display-only in this mode.

The server parses unified diff output into JSON for the UI: per file, `{path, oldPath, status: A|M|D|R, binary, additions, deletions, hunks: [{header, lines: [{type: ctx|add|del, old, new, text}]}]}`.

- Binary files: show "Binary file changed", no comments.
- Files over 1,500 changed lines: collapsed by default with a "Load diff" button.

## 5. Data model

```json
{
  "id": "a1b2c3",
  "title": "optional, from --title",
  "base": "<sha>",
  "status": "pending_review | changes_requested | approved",
  "rounds": [{"n": 1, "commit": "<sha>", "createdAt": "..."}],
  "consumed": 0,
  "nextCommentId": 5,
  "comments": [
    {
      "id": 3,
      "round": 1,
      "path": "src/parser.py",
      "side": "new",
      "start": 42,
      "end": 45,
      "anchor": ["exact text of lines 42..45"],
      "state": "draft | open | resolved | outdated",
      "thread": [
        {"author": "user", "body": "...", "round": 1, "at": "..."},
        {"author": "claude", "body": "...", "round": 2, "at": "..."}
      ]
    }
  ],
  "summaries": [{"round": 1, "body": "optional overall review comment"}]
}
```

- `side` is `new` (added or context line, numbered in the new file) or `old` (deleted line, numbered in the base file).
- A range must be contiguous lines on one side of one file.
- `draft` comments are stored server-side so a page reload never loses them. Submitting turns all drafts into `open`.
- `consumed` is the last round whose submitted review Claude has received, so `wait` never returns the same review twice.

### Relocating comments on a new round

When `review push` creates round N+1, for each `open` comment on the `new` side:

1. Look for the `anchor` lines as an exact contiguous match in the new version of the file, choosing the match nearest the old position.
2. If found, update `start`/`end`.
3. If not found (or the file was deleted), set `state: outdated`. The UI shows outdated comments in a collapsed "Outdated" block at the top of the file with the stored anchor text.

`old`-side comments refer to the fixed base, so they keep their line numbers. If the line no longer appears in the diff, mark them outdated.

## 6. CLI

All output is plain text, no colour, no banners and no progress messages. Errors go to stderr as one line.

| Command | Behaviour | Stdout on success |
|---|---|---|
| `review start [<ref>] [--title T] [--no-open] [--new]` | Start server if needed (detached, `start_new_session=True`). Run cleanup (section 6a). If an unfinished review exists, resume it (see 6a) unless `--new`. Otherwise create a review and round 1. Open the browser with `webbrowser.open` unless `--no-open`. | `review a1b2c3 round 1 http://127.0.0.1:PORT/#t=TOKEN`, or `resumed a1b2c3 round 2 changes_requested comments=2 http://...` |
| `review wait [--timeout S]` | Long-poll the server until a submitted, unconsumed review exists or the timeout passes. Default timeout 1,800 s. | See section 7 |
| `review push` | Read replies from stdin, apply them, snapshot round N+1, relocate comments, set status `pending_review`, notify the UI. | `round 2 ok` or `round 2 ok; unanswered: #5 #7` |
| `review status` | Current state. | `a1b2c3 round 2 pending_review open=1` |
| `review end` | Archive the review, delete its refs. | `ended a1b2c3` |
| `review serve` | Run the server in the foreground (used internally and for debugging). | — |
| `review stop` | Stop the server. | `stopped` |

Exit codes: `0` success, `2` wait timeout, `1` error.

### 6a. Crash recovery and cleanup

Nothing depends on the Claude session staying alive. All state is on disk (`review.json`, written atomically) and in git refs, and the server runs detached from Claude.

**If the Claude session crashes or is closed:**

- The server keeps running, so the page stays usable and the reviewer can still comment and submit.
- In a new session, `/local-review` runs `review start`, which finds the unfinished review and resumes it instead of creating a new one:
  - status `pending_review` → print `resumed ...`; Claude goes straight to `review wait`.
  - status `changes_requested` and not yet consumed → `review wait` returns the submitted comments immediately.
  - status `changes_requested`, already consumed, but no push recorded → the previous session crashed mid-fix. `review start` prints `resumed ... changes_requested comments=N`, and `review wait` re-delivers the same comments (reset `consumed` to the previous round). Claude checks the working tree, finishes the fixes and pushes as usual.
- Use `review start --new` to discard the unfinished review (it is archived and its refs deleted) and start fresh.

**If the server crashes:** `review start` and every client command detect a dead pid or unresponsive port in `server.json`, start a new server (new port and token) and continue from `review.json`. Draft comments survive because they are stored server-side on disk. The open browser tab shows `Server restarted · Reopen` with the new URL fetched via `review start --no-open`.

**If a snapshot is interrupted:** `index.tmp` is rebuilt from scratch with `git read-tree` on every snapshot, so a leftover file is harmless. A round is recorded in `review.json` only after its ref is written, so a half-made round never appears.

**Cleanup.** Snapshots are only reachable through `refs/local-review/<id>/*`; once those refs are deleted, `git gc` prunes the objects after its normal expiry (two weeks by default). Most snapshot objects are blobs already in the repo, so the extra disk use is small. Refs are deleted:

1. by `review end`;
2. automatically by `review start` when the current review is `approved` (archive it, delete its refs, then start a new one). This covers the normal case where the user commits after approval and never runs `review end`;
3. automatically by `review start` for any `refs/local-review/<id>/*` whose id is not the current review (orphans from crashes or manual deletion of `review.json`);
4. automatically by `review start` for archived reviews older than 30 days (`archive/<id>.json` files are deleted too).

The user never has to clean anything up manually. `review end` exists for when they want it done immediately.

### `review push` input format

One line per comment. The message runs to the end of the line.

```
#3 resolve: Renamed to parse_header and added a None check.
#4 reply: Kept the old behaviour because callers rely on it; see line 88.
#6 resolve
```

- `resolve` posts the reply (if any) and marks the thread resolved.
- `reply` posts the reply and leaves the thread open for the reviewer.
- Unknown ids are an error; the whole push is rejected and nothing changes.
- Comments not mentioned remain open and are listed as unanswered.

Claude calls it once per round with a heredoc:

```
review push <<'EOF'
#3 resolve: Renamed and added None check.
#4 reply: Intentional; callers rely on it.
EOF
```

## 7. `review wait` output (token-critical)

### Changes requested

```
CHANGES_REQUESTED round=1 comments=2
#3 src/parser.py:+42-45
> def parse(h):
>     return h.split(":")
> ...(+2)
Rename to parse_header and handle None.
#4 src/util.py:-10
> retries = 3
Why was this removed?
SUMMARY: Mostly good, just these two.
```

Rules:

- Header line: status, round and comment count only.
- Location: `path:+N` or `path:+N-M` for new-side lines, `path:-N` for old-side (deleted) lines.
- Code snippet: at most **2 lines** of the anchor, each truncated to 100 characters with `…`, then `...(+K)` if more lines exist. Claude can read the file if it needs more.
- Only include threads needing Claude's attention: new comments, and resolved or open threads where the reviewer added a reply since Claude's last reply. For a follow-up, print only the reviewer's new message(s), prefixed `(follow-up)`. Do not repeat Claude's earlier reply.
- Omit resolved threads with no new activity and all outdated threads unless the reviewer replied on them.
- `SUMMARY:` only if the reviewer wrote one.

### Approved

```
APPROVED round=3
```

If the reviewer added comments while approving, they follow as above (informational; no push is required).

### Timeout

```
TIMEOUT
```

## 8. HTTP server

An Express app, bound to `127.0.0.1` on a free port chosen by the OS. Static files from `ui/`; JSON API under `/api/`.

### Security (must have)

- Random 32-byte token (`crypto.randomBytes(32)`, base64url), stored in `server.json` with mode `0600`.
- The browser receives the token in the URL fragment (`#t=...`), so it never appears in server logs or `Referer`. `app.js` reads it, stores it in `sessionStorage`, and sends it as `Authorization: Bearer <token>` on every API call.
- Reject any `/api/` request without the correct token (constant-time compare via `crypto.timingSafeEqual`).
- Reject requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
- For state-changing requests, require `Origin` to be absent or exactly `http://127.0.0.1:<port>` / `http://localhost:<port>`.
- Accept only `Content-Type: application/json` on POST.
- All git calls via `child_process.spawnSync("git", [...])` with an argument list, never a shell. Validate refs with `git rev-parse --verify --end-of-options <ref>^{commit}`. Validate paths against the parsed diff's file list before use.
- The UI renders every user-, file- and Claude-supplied string with `textContent`, never `innerHTML`.
- The server never makes outbound network requests.

### Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/review` | Review metadata, rounds, status, comments |
| `GET /api/diff?round=N&since=K` | Parsed diff (`since` optional) |
| `GET /api/events?version=V` | Long-poll (25 s) for any state change; returns new `version`. Used by the UI to refresh. |
| `POST /api/comments` | Create a draft comment `{path, side, start, end, body}` |
| `PATCH /api/comments/<id>` | Edit body (drafts only) or change state (resolve/unresolve) |
| `DELETE /api/comments/<id>` | Delete a draft |
| `POST /api/comments/<id>/replies` | Reviewer reply on a submitted thread (stored as a draft reply until submit) |
| `POST /api/submit` | `{verdict: "request_changes" | "approve", summary}`; promotes drafts, sets status |
| `GET /api/wait?timeout=S` | Used by `review wait`; returns the formatted text from section 7 |
| `POST /api/push` | Used by `review push`; body is the raw stdin text |

The server keeps a monotonically increasing `version`; every mutation bumps it and wakes long-pollers. Git runs synchronously, so every operation is atomic on the event loop; only the long-polls (`wait`, `events`) yield.

### Lifetime

- `review start` launches the server detached if `server.json` is missing or its pid is dead or not responding.
- The server shuts itself down after 2 hours with no API requests and no `pending_review` status.

## 9. UI

Plain HTML, CSS and JavaScript (ES2020, no framework; highlight.js for syntax colouring). Should look and behave like GitHub's pull request "Files changed" tab. Light and dark themes via `prefers-color-scheme`, using GitHub-like colours.

### Layout

- **Top bar:** review title (or branch name), base short SHA, round selector (`Round 2 of 2`), view toggle (`All changes` / `Changes since round K`), counts (`4 files, +120 −35`), and a green **Finish your review** button showing the draft count.
- **Left sidebar (resizable, collapsible):** file tree grouped by directory, with a filter box. Each file shows a status marker (A green, M amber, D red, R blue), `+/−` counts, an open-comment count, and a tick when marked viewed. Clicking scrolls to the file.
- **Main area:** one card per file, in tree order.
  - Sticky header: collapse chevron, path (for renames `old → new`), `+/−` bar, **Viewed** checkbox (collapses the card; stored in `localStorage` keyed by review id, round and path).
  - Unified diff table: old line number, new line number, code. Hunk header rows (`@@ -a,b +c,d @@ context`). Add and delete rows tinted green and red. Monospace font, tab size 4, long lines wrap. Syntax highlighting by file extension (highlight.js common languages, GitHub colours in both themes): each hunk's old side (context + deleted) and new side (context + added) is highlighted as one block so multi-line strings and comments colour correctly, then split back into lines. Only the highlighter's text and class names are kept (parsed inertly, rebuilt with text nodes). Files over 200,000 characters of diff, or in unknown languages, stay plain.

### Commenting

- Hovering a line shows a blue **+** in the gutter.
- Click **+**: single-line comment.
- Click and drag down the **+** column, or click one line then shift-click another: range comment. Constrain the range to one hunk run of the same side; highlight the selected rows in yellow while selecting.
- The comment form appears under the last selected line: label `Comment on lines +42 to +45`, a textarea, **Add review comment** and **Cancel**. `Ctrl/Cmd+Enter` submits the form.
- Draft comments show a **Pending** badge and can be edited or deleted.
- Threads display under the last line of their range, showing author (`You` / `Claude`), round and body. Plain text only, with preserved line breaks and inline `` `code` `` spans; no Markdown.
- Each submitted thread has **Reply** and **Resolve** / **Unresolve**. Resolved threads collapse to one line (`Resolved: Rename to parse_header…`). Outdated threads sit in a collapsed block at the top of their file.

### Finishing a review

The **Finish your review** popover has a summary textarea and two options, **Request changes** and **Approve**, plus **Submit review**. Request changes requires at least one comment or a summary.

### Live state

- The UI long-polls `/api/events`. When status becomes `pending_review` with a new round, show a banner `Claude pushed round 3 · View` that switches to the new round and keeps scroll position per file where possible.
- While Claude is working (status `changes_requested`), show `Waiting for Claude…` and disable **Finish your review**.
- After approval, show `Approved · ready to commit`.

### Keyboard (nice to have)

`j`/`k` next/previous file, `n` next open thread, `v` toggle viewed on the current file.

## 10. Claude Code integration

### Slash command: `commands/local-review.md`

Install by copying to `~/.claude/commands/local-review.md`.

```markdown
---
description: GitHub-style local review of current changes; iterate until approved
allowed-tools: Bash(review:*)
---
Run `review start $ARGUMENTS` and give the user the URL in one line.

Then run `review wait` as a background command and stop. You will be notified when it exits. Never poll.

When `review wait` exits:
- TIMEOUT: start `review wait` in the background again. Say nothing.
- APPROVED: say "Approved." in one line. Do not commit, stage or end the review unless asked.
- CHANGES_REQUESTED: address every listed comment. Read only the files and lines you need. Then run one `review push` heredoc with one line per comment: `#<id> resolve: <what you changed>` when fixed, `#<id> reply: <answer>` for questions or disagreement. Keep each reply under 25 words. Then start `review wait` in the background again. Do not summarise the changes to the user; the review page shows them.

If `review push` reports unanswered comments, answer them with another push before waiting.
```

### Permissions

The `allowed-tools` line lets Claude run `review` without approval prompts during the loop. Nothing else is needed: no MCP server, no hooks.

### Fallback if background commands are unavailable

Replace the background instruction with: run `review wait --timeout 590` in the foreground; on `TIMEOUT`, run it again.

## 11. Phase 2 (after v1 works)

- Split (side-by-side) view toggle.
- Expand hidden context between hunks (`GET /api/blob?round=N&path=P&from=&to=` via `git show <commit>:<path>`).
- Lightweight syntax highlighting with a small built-in tokeniser for the user's main languages (no library).
- Suggested changes: a comment with a ```` ```suggestion ```` block that Claude applies verbatim.
- `review start --staged` to review only staged changes.

## 12. Testing

Built-in `node:test` only (`npm test`, i.e. `node --test`). Each test creates a throwaway repository in a temp directory.

- Snapshot: untracked files included, ignored files excluded, user's real index unchanged (compare `git ls-files -s` before and after).
- Diff parser: add, modify, delete, rename, binary, no-newline-at-end, empty file.
- Relocation: comment survives lines inserted above it; becomes outdated when its lines are edited or the file is deleted.
- `wait` output: golden-file tests for changes requested, follow-ups, approved, timeout; snippet truncation.
- `push` parsing: valid input, unknown id rejected atomically, unanswered list.
- Security: missing or wrong token → 401; foreign `Host` → 403; foreign `Origin` on POST → 403; non-JSON POST → 415.
- Concurrency: `wait` wakes within one second of submit.
- Recovery: kill the server mid-review → next command restarts it with comments and drafts intact; consume a review without pushing → `review start` resumes and `wait` re-delivers the comments.
- Cleanup: `start` after an approved review deletes the old refs; orphaned `refs/local-review/*` are removed; `git for-each-ref refs/local-review` shows only the current review.

## 13. Acceptance criteria

1. From a repo with uncommitted changes, `/local-review` opens a page listing every changed, added, deleted and renamed file with correct diffs, including untracked files.
2. The reviewer can add single-line and range comments on both added and deleted lines, keep them as drafts across a page reload, and submit with Request changes or Approve.
3. Claude is notified on submit without polling, replies to every comment in a single `review push`, and round 2 appears in the open page with replies threaded and comments relocated or marked outdated.
4. "Changes since round 1" shows only what Claude changed in response.
5. Approve ends the loop; nothing was committed, staged or added to the user's index.
6. A typical round costs Claude one `wait` result and one `push` call; `wait` output for a two-comment review is under 120 tokens.
7. The project runs with `node` 22+ on macOS and Linux after `npm install`, with only the dependencies listed in section 1.
