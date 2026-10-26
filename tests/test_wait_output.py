import os
import unittest

from helpers import GOLDEN, TempRepo, lines, review


def golden(name):
    with open(os.path.join(GOLDEN, name), encoding="utf-8") as f:
        return f.read().rstrip("\n")


class WaitOutputTest(unittest.TestCase):
    """Reproduces the example from the spec, then follow-up and approval rounds."""

    def setUp(self):
        repo = self.repo = TempRepo()
        repo.write("src/parser.py", lines(41, "# filler"))
        repo.write("src/util.py", lines(9, "# u") + "retries = 3\n" + lines(5, "# v"))
        repo.commit()
        repo.write("src/parser.py", lines(41, "# filler") +
                   'def parse(h):\n    return h.split(":")\n\n# end\n')
        repo.write("src/util.py", lines(9, "# u") + lines(5, "# v"))
        self.core = repo.core()
        self.core.start()
        # Burn ids 1 and 2 so the comments get the ids used in the spec.
        for _ in range(2):
            c = self.core.add_comment({"path": "src/util.py", "side": "old", "start": 10, "end": 10, "body": "x"})
            self.core.delete_comment(c["id"])
        self.core.add_comment({"path": "src/parser.py", "side": "new", "start": 42, "end": 45,
                               "body": "Rename to parse_header and handle None."})
        self.core.add_comment({"path": "src/util.py", "side": "old", "start": 10, "end": 10,
                               "body": "Why was this removed?"})

    def tearDown(self):
        self.repo.cleanup()

    def test_changes_requested_followup_approved(self):
        self.core.submit({"verdict": "request_changes", "summary": "Mostly good, just these two."})
        text = self.core.wait(0)
        self.assertEqual(text, golden("changes_requested.txt"))
        self.assertLess(len(text), 480)  # ~120 tokens at ~4 chars/token

        # Already consumed: never returned twice.
        self.assertEqual(self.core.wait(0), "TIMEOUT")

        self.core.push("#3 resolve: Renamed.\n#4 reply: Intentional; callers rely on it.")
        self.core.add_reply(4, {"body": "Please restore it."})
        self.core.submit({"verdict": "request_changes"})
        self.assertEqual(self.core.wait(0), golden("followup.txt"))

        self.core.push("#4 resolve: Restored.")
        self.core.submit({"verdict": "approve"})
        self.assertEqual(self.core.wait(0), golden("approved.txt"))

    def test_timeout(self):
        self.assertEqual(self.core.wait(0), golden("timeout.txt"))

    def test_request_changes_needs_comment_or_summary(self):
        for c in list(self.core.review["comments"]):
            self.core.delete_comment(c["id"])
        with self.assertRaises(review.ReviewError):
            self.core.submit({"verdict": "request_changes"})
        self.core.submit({"verdict": "request_changes", "summary": "Rethink this."})
        self.assertEqual(self.core.wait(0), "CHANGES_REQUESTED round=1 comments=0\nSUMMARY: Rethink this.")

    def test_snippet_truncation(self):
        long = "x" * 150
        self.assertEqual(review.format_snippet([long]), ["> " + "x" * 99 + "…"])
        self.assertEqual(review.format_snippet(["a", "b", "c"]), ["> a", "> b", "...(+1)"])


if __name__ == "__main__":
    unittest.main()
