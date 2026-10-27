---
description: GitHub-style local review of current changes; iterate until approved
argument-hint: "[<base-ref> | new [<base-ref>] | status | open | pause | stop]"
allowed-tools: Bash(node /Users/ivansadikov/Developer/redline/bin/redline.js:*), Bash(git log:*), Bash(git diff:*), Bash(git status:*)
---
`REVIEW` below stands for `node /Users/ivansadikov/Developer/redline/bin/redline.js`. Always run it with that full command.

Arguments: `$ARGUMENTS`. Act on the first word:

- `status`: run `REVIEW status` and relay its output in one line. Nothing else.
- `open`: run `REVIEW open` (opens the page) and give the user the URL in one line. Nothing else.
- `pause`: stop any background `REVIEW wait` you started, then run `REVIEW stop`. Say "Paused; run /redline to resume." in one line. The review is kept.
- `stop`: stop any background `REVIEW wait` you started, run `REVIEW end` (ignore a "no active review" error), then `REVIEW stop`. Say "Review ended." in one line.
- `new`: run `REVIEW start --new <remaining arguments>`, then continue with **The loop** below.
- anything else, or nothing: run `REVIEW start $ARGUMENTS`, then continue with **The loop** below.

## The loop

Give the user the URL from `REVIEW start` in one line.

Then run `REVIEW wait` as a background command and stop. You will be notified when it exits. Never poll.

When `REVIEW wait` exits:
- TIMEOUT: start `REVIEW wait` in the background again. Say nothing.
- STOPPED or ENDED: the review was paused, stopped or replaced. Say nothing and do not wait again.
- APPROVED without `commit=requested`: say "Approved." in one line. Do not commit, stage or end the review unless asked.
- APPROVED with `commit=requested`: write a commit message for the reviewed changes. Base it on what you changed and on the commits already on the branch (`git log -n 20`), matching their style. Then run it once with a heredoc and do not commit any other way:
  ```
  REVIEW commit <<'EOF'
  <subject line>

  <optional body>
  EOF
  ```
  Report the result in one line. If it fails, tell the user the error in one line and stop.
- CHANGES_REQUESTED: address every listed comment. Read only the files and lines you need. Then run one `REVIEW push` heredoc with one line per comment: `#<id> resolve: <what you changed>` when fixed, `#<id> reply: <answer>` for questions or disagreement. Keep each reply under 25 words. Then start `REVIEW wait` in the background again. Do not summarise the changes to the user; the review page shows them.

If `REVIEW push` reports unanswered comments, answer them with another push before waiting.
