import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { review } from "./helpers.js";

const { MAX_SUBJECT, checkCommitMessage } = review;
const TRAILERS = "Co-Authored-By: A <a@example.com>\nSigned-off-by: B <b@example.com>\n";

describe("commit message layout", () => {
  const accepted = {
    "subject and body": "Subject\n\nBody.\n",
    "several paragraphs": "Subject\n\nOne.\n\nTwo.\n",
    "body and trailers": `Subject\n\nBody.\n\n${TRAILERS}`,
    "surrounding blank lines": "\n\nSubject\n\n\nBody.\n\n",
    "CRLF line endings": "Subject\r\n\r\nBody.\r\n",
    "subject at the limit": `${"x".repeat(MAX_SUBJECT)}\n\nBody.\n`,
    "body with a colon in prose": "Subject\n\nTwo changes here: this and that.\n",
  };
  for (const [name, message] of Object.entries(accepted)) {
    test(`accepts ${name}`, () => checkCommitMessage(message));
  }

  const rejected = {
    "a subject over the limit": [`${"x".repeat(MAX_SUBJECT + 1)}\n\nBody.\n`, /subject is 73 characters; the limit is 72/],
    "no blank line after the subject": ["Subject\nBody.\n", /needs a blank line/],
    "no body": ["Subject\n", /needs a body/],
    "only blank lines after the subject": ["Subject\n\n \n", /needs a body/],
    "only trailers": [`Subject\n\n${TRAILERS}`, /needs a body/],
    "only folded trailers": ["Subject\n\nCo-Authored-By: A\n <a@example.com>\n", /needs a body/],
  };
  for (const [name, [message, error]] of Object.entries(rejected)) {
    test(`rejects ${name}`, () => {
      assert.throws(() => checkCommitMessage(message), (e) => e instanceof review.ReviewError && error.test(e.message));
    });
  }

  test("counts characters, not UTF-16 units", () => {
    checkCommitMessage(`${"\u{1F600}".repeat(MAX_SUBJECT)}\n\nBody.\n`);
  });
});
