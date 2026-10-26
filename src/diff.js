// Parsing `git diff` output into the JSON shape used by the UI.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Parse a C-quoted git path starting at s[i] == '"'. Returns [value, next index]. */
function parseQuoted(s, i = 0) {
  const out = [];
  const push = (str) => out.push(...Buffer.from(str, "utf8"));
  const decode = () => Buffer.from(out).toString("utf8");
  i += 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return [decode(), i + 1];
    if (ch === "\\" && i + 1 < s.length) {
      const nxt = s[i + 1];
      if (Object.hasOwn(C_ESCAPES, nxt)) {
        out.push(C_ESCAPES[nxt]);
        i += 2;
      } else if ("01234567".includes(nxt)) {
        out.push(parseInt(s.slice(i + 1, i + 4), 8) & 0xff);
        i += 4;
      } else {
        const c = String.fromCodePoint(s.codePointAt(i + 1));
        push(c);
        i += 1 + c.length;
      }
    } else {
      const c = String.fromCodePoint(s.codePointAt(i));
      push(c);
      i += c.length;
    }
  }
  return [decode(), i];
}

/** A path from a `---`/`+++`/`rename` header line, without quoting. */
function headerPath(s) {
  if (s.startsWith('"')) return parseQuoted(s)[0];
  // git appends a tab to unquoted names containing spaces
  return s.endsWith("\t") ? s.slice(0, -1) : s;
}

function stripPrefix(p, prefix) {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Split the 'a/X b/Y' part of a `diff --git` line. */
function splitGitHeader(rest) {
  if (rest.startsWith('"')) {
    const [a, i] = parseQuoted(rest);
    return [a, headerPath(rest.slice(i + 1))];
  }
  if (rest.endsWith('"')) {
    const j = rest.lastIndexOf(' "');
    return [rest.slice(0, j), parseQuoted(rest, j + 1)[0]];
  }
  // Unquoted: without a rename both names have the same length.
  const n = Math.floor((rest.length - 1) / 2);
  return [rest.slice(0, n), rest.slice(n + 1)];
}

/** Parse `git diff` output into the JSON shape used by the UI. */
export function parseDiff(text) {
  const lines = text.split("\n");
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const [a, b] = splitGitHeader(lines[i].slice("diff --git ".length));
    let oldPath = stripPrefix(a, "a/"), newPath = stripPrefix(b, "b/");
    const f = { path: null, oldPath: null, status: "M", binary: false, additions: 0, deletions: 0, hunks: [] };
    i += 1;
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
      const hl = lines[i];
      if (hl.startsWith("new file mode ")) {
        f.status = "A";
        f.newMode = hl.slice(14);
      } else if (hl.startsWith("deleted file mode ")) {
        f.status = "D";
        f.oldMode = hl.slice(18);
      } else if (hl.startsWith("old mode ")) {
        f.oldMode = hl.slice(9);
      } else if (hl.startsWith("new mode ")) {
        f.newMode = hl.slice(9);
      } else if (hl.startsWith("rename from ")) {
        f.status = "R";
        oldPath = headerPath(hl.slice(12));
      } else if (hl.startsWith("rename to ")) {
        newPath = headerPath(hl.slice(10));
      } else if (hl.startsWith("Binary files ") || hl === "GIT binary patch") {
        f.binary = true;
      } else if (hl.startsWith("--- ")) {
        const p = headerPath(hl.slice(4));
        if (p !== "/dev/null") oldPath = stripPrefix(p, "a/");
      } else if (hl.startsWith("+++ ")) {
        const p = headerPath(hl.slice(4));
        if (p !== "/dev/null") newPath = stripPrefix(p, "b/");
      }
      i += 1;
    }
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = HUNK_RE.exec(lines[i]);
      if (!m) break;
      let oldNo = parseInt(m[1], 10), newNo = parseInt(m[3], 10);
      let remOld = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      let remNew = m[4] !== undefined ? parseInt(m[4], 10) : 1;
      const hunk = { header: lines[i], lines: [] };
      i += 1;
      while (i < lines.length && (remOld > 0 || remNew > 0 || lines[i].startsWith("\\"))) {
        const line = lines[i];
        const kind = line.slice(0, 1);
        if (kind === "\\") {
          if (hunk.lines.length) hunk.lines[hunk.lines.length - 1].noeol = true;
        } else if (kind === "+") {
          hunk.lines.push({ type: "add", old: null, new: newNo, text: line.slice(1) });
          newNo += 1;
          remNew -= 1;
          f.additions += 1;
        } else if (kind === "-") {
          hunk.lines.push({ type: "del", old: oldNo, new: null, text: line.slice(1) });
          oldNo += 1;
          remOld -= 1;
          f.deletions += 1;
        } else if (kind === " " || line === "") {
          hunk.lines.push({ type: "ctx", old: oldNo, new: newNo, text: line.slice(1) });
          oldNo += 1;
          newNo += 1;
          remOld -= 1;
          remNew -= 1;
        } else {
          break;
        }
        i += 1;
      }
      f.hunks.push(hunk);
    }
    if (f.status === "D") {
      f.path = f.oldPath = oldPath;
    } else if (f.status === "A") {
      f.path = newPath;
    } else {
      f.path = newPath;
      f.oldPath = oldPath;
    }
    files.push(f);
  }
  return files;
}

/**
 * Anchor texts for lines start..end on `side` of one hunk, or null if invalid.
 *
 * New side: context and added lines. Old side: deleted lines only.
 */
export function collectRange(f, side, start, end) {
  if (f == null || f.binary || start < 1 || end < start) return null;
  for (const hunk of f.hunks) {
    const nums = new Map();
    for (const line of hunk.lines) {
      if (side === "new" && line.type !== "del") nums.set(line.new, line.text);
      else if (side === "old" && line.type === "del") nums.set(line.old, line.text);
    }
    if (nums.has(start)) {
      const out = [];
      for (let n = start; n <= end; n++) {
        if (!nums.has(n)) return null;
        out.push(nums.get(n));
      }
      return out;
    }
  }
  return null;
}

/** 1-based start of the exact match of `anchor` in `lines` closest to `near`. */
export function findAnchor(lines, anchor, near) {
  if (!anchor || !anchor.length) return null;
  const k = anchor.length;
  let best = null;
  for (let i = 0; i + k <= lines.length; i++) {
    if (lines[i] === anchor[0] && anchor.every((a, j) => lines[i + j] === a)) {
      if (best === null || Math.abs(i + 1 - near) < Math.abs(best - near)) best = i + 1;
    }
  }
  return best;
}
