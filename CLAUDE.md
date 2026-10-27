# Project instructions

## Coding

Always use only ASCII characters in the code and comments unless the string
requires to be in UTF-8, e.g. testing different encodings.

Use ES module syntax (`import`/`export`) instead of CommonJS
(`require`/`module.exports`).

Don't hack the code or take shortcuts to get the job done. Prioritise good
code design, composition, future extension, and ease of read. In particular:

- Don't stuff new functionality into an existing variable/element/function
  just because it's already wired up somewhere convenient. Give the new
  piece its own clearly-named element and compose it with the existing one,
  even if that means one more edit.
- Don't route around a limitation with an encoding trick or other indirect
  workaround. Fix the actual cause.
- Don't bolt a special case onto shared/generic code to handle one caller's
  need. Prefer generalizing the underlying mechanism, or moving the logic to
  the layer that actually owns it.
- Prefer the simplest form that is still correct, but never at the cost of
  hiding what the code is actually doing.

## Testing

Always run the tests before reporting test results:

```
npm test
```

## UI

The UI in `ui/` is plain HTML, CSS and JavaScript with no build step and no
CDN. Third-party browser code is served from `node_modules` (see
`redline-spec.md`).

## Claude commands

`commands/redline.md` is the Claude Code slash command. Whenever it changes,
also copy it to the installed location so the two stay identical:

```
cp commands/redline.md ~/.claude/commands/redline.md
```

If a change to the CLI (subcommands, flags, or the text `redline wait` /
`redline push` print) affects how the command drives the loop, update
`commands/redline.md` in the same change, then copy it as above.
