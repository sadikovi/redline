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
