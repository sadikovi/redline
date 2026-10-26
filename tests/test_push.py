import unittest

from helpers import TempRepo, lines, review


class PushParseTest(unittest.TestCase):
    def test_valid(self):
        text = "#3 resolve: Renamed and added None check.\n\n#4 reply: Intentional: see line 88.\n#6 resolve\n"
        self.assertEqual(review.parse_push(text), [
            (3, "resolve", "Renamed and added None check."),
            (4, "reply", "Intentional: see line 88."),
            (6, "resolve", None),
        ])

    def test_invalid(self):
        for bad in ("#3 fixed it", "3 resolve: x", "#4 reply", "#4 reply:   "):
            with self.assertRaises(review.ReviewError, msg=bad):
                review.parse_push(bad)


class PushTest(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.repo.write("a.txt", lines(10))
        self.repo.commit()
        self.repo.write("a.txt", lines(10).replace("line 2\n", "two\n").replace("line 8\n", "eight\n"))
        self.core = self.repo.core()
        self.core.start()
        for n in (2, 8):
            self.core.add_comment({"path": "a.txt", "side": "new", "start": n, "end": n, "body": "why?"})
        self.core.submit({"verdict": "request_changes"})
        self.core.wait(0)

    def tearDown(self):
        self.repo.cleanup()

    def test_unknown_id_rejected_atomically(self):
        before = self.core.review
        refs = self.repo.git("for-each-ref", "refs/local-review")
        with self.assertRaises(review.ReviewError) as cm:
            self.core.push("#1 resolve: done\n#99 reply: what")
        self.assertIn("#99", str(cm.exception))
        self.assertEqual(self.core.review, before)
        self.assertEqual(self.repo.git("for-each-ref", "refs/local-review"), refs)

    def test_unanswered_listed(self):
        self.assertEqual(self.core.push("#1 resolve: done"), "round 2 ok; unanswered: #2")
        r = self.core.review
        self.assertEqual(r["status"], "pending_review")
        self.assertEqual([c["state"] for c in r["comments"]], ["resolved", "open"])
        self.assertEqual(r["comments"][0]["thread"][-1],
                         dict(r["comments"][0]["thread"][-1], author="claude", body="done", round=2))

    def test_all_answered(self):
        self.assertEqual(self.core.push("#1 resolve: done\n#2 reply: because"), "round 2 ok")
        self.assertEqual(len(self.core.review["rounds"]), 2)

    def test_push_requires_changes_requested(self):
        self.core.push("#1 resolve\n#2 resolve")
        with self.assertRaises(review.ReviewError):
            self.core.push("#1 resolve")


if __name__ == "__main__":
    unittest.main()
