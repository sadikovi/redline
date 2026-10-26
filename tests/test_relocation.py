import unittest

from helpers import TempRepo, lines


class RelocationTest(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.repo.write("a.txt", lines(20))
        self.repo.write("b.txt", lines(5, "b"))
        self.repo.commit()
        # Round 1: change lines 10-11 in a.txt, delete b 3.
        self.repo.write("a.txt", lines(20).replace("line 10\n", "ten\n").replace("line 11\n", "eleven\n"))
        self.repo.write("b.txt", lines(5, "b").replace("b 3\n", ""))
        self.core = self.repo.core()
        self.core.start()

    def tearDown(self):
        self.repo.cleanup()

    def comment(self, path, side, start, end):
        return self.core.add_comment({"path": path, "side": side, "start": start, "end": end, "body": "fix"})["id"]

    def request_changes(self):
        self.core.submit({"verdict": "request_changes"})
        self.core.wait(0)

    def get(self, cid):
        return next(c for c in self.core.review["comments"] if c["id"] == cid)

    def test_survives_lines_inserted_above(self):
        cid = self.comment("a.txt", "new", 10, 11)
        self.request_changes()
        content = "new top\nanother\n" + lines(20).replace("line 10\n", "ten\n").replace("line 11\n", "eleven\n")
        self.repo.write("a.txt", content)
        self.core.push("#%d reply: looking" % cid)
        c = self.get(cid)
        self.assertEqual((c["state"], c["start"], c["end"]), ("open", 12, 13))

    def test_outdated_when_lines_edited(self):
        cid = self.comment("a.txt", "new", 10, 11)
        self.request_changes()
        self.repo.write("a.txt", lines(20).replace("line 10\n", "TEN\n").replace("line 11\n", "eleven\n"))
        self.core.push("")
        self.assertEqual(self.get(cid)["state"], "outdated")

    def test_outdated_when_file_deleted(self):
        cid = self.comment("a.txt", "new", 10, 10)
        self.request_changes()
        self.repo.remove("a.txt")
        self.core.push("")
        self.assertEqual(self.get(cid)["state"], "outdated")

    def test_resolved_thread_relocates_too(self):
        cid = self.comment("a.txt", "new", 11, 11)
        self.request_changes()
        self.repo.write("a.txt", "top\n" + lines(20).replace("line 10\n", "ten\n").replace("line 11\n", "eleven\n"))
        self.core.push("#%d resolve: done" % cid)
        c = self.get(cid)
        self.assertEqual((c["state"], c["start"]), ("resolved", 12))

    def test_old_side_keeps_numbers_or_goes_outdated(self):
        keep = self.comment("b.txt", "old", 3, 3)
        gone = self.comment("a.txt", "old", 10, 10)
        self.request_changes()
        # Restore a.txt line 10: the deleted line is no longer in the diff.
        self.repo.write("a.txt", lines(20).replace("line 11\n", "eleven\n"))
        self.core.push("")
        self.assertEqual((self.get(keep)["state"], self.get(keep)["start"]), ("open", 3))
        self.assertEqual(self.get(gone)["state"], "outdated")


if __name__ == "__main__":
    unittest.main()
