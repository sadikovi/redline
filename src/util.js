import fs from "node:fs";
import writeFileAtomic from "write-file-atomic";

export class ReviewError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Python-style str.splitlines(): no trailing empty element. */
export function splitlines(s) {
  const out = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Atomic (temp file + fsync + rename), created 0600. */
export function writeFileSafe(path, data) {
  writeFileAtomic.sync(path, data, { mode: 0o600 });
}

export function writeJson(path, obj) {
  writeFileSafe(path, JSON.stringify(obj, null, 1));
}

export function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function unlinkQuiet(path) {
  fs.rmSync(path, { force: true });
}
