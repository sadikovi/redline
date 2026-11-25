// The layout `redline commit` requires of a commit message, and the trailer it adds.
import { ReviewError, splitlines } from "./util.js";

export const MAX_SUBJECT = 72;
const REVIEW_TRAILER = "Reviewed-with: redline";

const TRAILER_RE = /^[A-Za-z0-9-]+\s*:\s*\S/;
const CONTINUATION_RE = /^\s+\S/; // a folded trailer value

const isBlank = (line) => !line.trim();

function isTrailerBlock(lines) {
  return lines.length > 0 && TRAILER_RE.test(lines[0])
    && lines.every((line) => TRAILER_RE.test(line) || CONTINUATION_RE.test(line));
}

/** Split off a closing block of trailers (`Key: value`): {body, trailers}, both lists of lines. */
function splitTrailers(lines) {
  const end = lines.findLastIndex((line) => !isBlank(line)) + 1;
  const start = lines.slice(0, end).findLastIndex(isBlank) + 1;
  const last = lines.slice(start, end);
  return isTrailerBlock(last)
    ? { body: lines.slice(0, start), trailers: last }
    : { body: lines.slice(0, end), trailers: [] };
}

/**
 * Throw unless `message` is a short subject line, a blank line and a body. Trailers alone
 * are not a body.
 */
export function checkCommitMessage(message) {
  const [subject, separator = "", ...rest] = splitlines(message.trim());
  const length = Array.from(subject).length;
  if (length > MAX_SUBJECT) {
    throw new ReviewError(`commit subject is ${length} characters; the limit is ${MAX_SUBJECT}`);
  }
  if (!isBlank(separator)) throw new ReviewError("commit message needs a blank line after the subject");
  if (splitTrailers(rest).body.every(isBlank)) throw new ReviewError("commit message needs a body after the subject");
}

/**
 * A checked message with the review trailer added to its trailers. Not `git commit --trailer`,
 * which takes closing lines that start with "#" for comments and puts the trailer above them.
 */
export function addReviewTrailer(message) {
  const [subject, separator, ...rest] = splitlines(message.trim());
  const { body, trailers } = splitTrailers(rest);
  if (!trailers.includes(REVIEW_TRAILER)) trailers.push(REVIEW_TRAILER);
  const text = [subject, separator, ...body].join("\n").trimEnd();
  return `${text}\n\n${trailers.join("\n")}\n`;
}
