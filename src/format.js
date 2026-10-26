// The text `review wait` prints and `review push` reads.
import { ReviewError, splitlines } from "./util.js";

export const PENDING = "pending_review", CHANGES = "changes_requested", APPROVED = "approved";
const SNIPPET_LINES = 2;
const SNIPPET_WIDTH = 100;

function threadEntries(c) {
  return c.thread.filter((e) => !e.draft);
}

/** Submitted threads needing Claude: [[comment, isFollowup, user messages]]. */
export function attention(r) {
  const n = r.rounds.length;
  const out = [];
  for (const c of [...r.comments].sort((x, y) => x.id - y.id)) {
    if (c.state === "draft") continue;
    const thread = threadEntries(c);
    let lastClaude = -1;
    thread.forEach((e, i) => {
      if (e.author === "claude") lastClaude = i;
    });
    const pending = thread.slice(lastClaude + 1).filter((e) => e.author === "user");
    if (!pending.length) continue;
    if (c.state !== "open" && !pending.some((e) => e.round === n)) continue;
    out.push([c, lastClaude >= 0, pending]);
  }
  return out;
}

function formatLocation(c) {
  const sign = c.side === "new" ? "+" : "-";
  let loc = `${c.path}:${sign}${c.start}`;
  if (c.end !== c.start) loc += `-${c.end}`;
  return `#${c.id} ${loc}`;
}

export function formatSnippet(anchor) {
  const out = [];
  for (let line of anchor.slice(0, SNIPPET_LINES)) {
    const chars = Array.from(line.trimEnd());
    line = chars.length > SNIPPET_WIDTH ? chars.slice(0, SNIPPET_WIDTH - 1).join("") + "…" : chars.join("");
    out.push(("> " + line).trimEnd());
  }
  if (anchor.length > SNIPPET_LINES) out.push(`...(+${anchor.length - SNIPPET_LINES})`);
  return out;
}

export function formatWait(r) {
  const n = r.rounds.length;
  const items = attention(r);
  const out = r.status === APPROVED
    ? [`APPROVED round=${n}` + (r.commitRequested ? " commit=requested" : "")]
    : [`CHANGES_REQUESTED round=${n} comments=${items.length}`];
  for (const [c, followup, msgs] of items) {
    out.push(formatLocation(c));
    if (followup) {
      out.push(...msgs.map((m) => "(follow-up) " + m.body.trimEnd()));
    } else {
      out.push(...formatSnippet(c.anchor));
      out.push(...msgs.map((m) => m.body.trimEnd()));
    }
  }
  for (const s of r.summaries || []) {
    if (s.round === n) out.push("SUMMARY: " + s.body.trimEnd());
  }
  return out.join("\n");
}

const PUSH_RE = /^#(\d+)\s+(resolve|reply)\b\s*(?::\s*(.*))?$/;

/** Parse push input into [[id, action, message or null]]. */
export function parsePush(text) {
  const entries = [];
  splitlines(text).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const m = PUSH_RE.exec(line);
    if (!m) throw new ReviewError(`line ${idx + 1}: expected '#<id> resolve|reply: <message>'`);
    const msg = (m[3] || "").trim() || null;
    if (m[2] === "reply" && !msg) throw new ReviewError(`line ${idx + 1}: reply needs a message`);
    entries.push([parseInt(m[1], 10), m[2], msg]);
  });
  return entries;
}
