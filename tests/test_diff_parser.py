import unittest

from helpers import TempRepo, lines, review


class DiffParserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        repo = cls.repo = TempRepo()
        repo.write("modify.txt", lines(10))
        repo.write("delete.txt", "gone\n")
        repo.write("old_name.txt", lines(20, "keep"))
        repo.write("image.bin", b"\x00\x01\x02binary")
        repo.write("noeol.txt", "a\nb")
        repo.commit()

        repo.write("modify.txt", lines(10).replace("line 5\n", "line five\n"))
        repo.remove("delete.txt")
        repo.git("mv", "old_name.txt", "new name.txt")
        repo.write("added.txt", "x\ny\n")
        repo.write("image.bin", b"\x00\x01\x03binary!")
        repo.write("noeol.txt", "a\nc")
        repo.write("empty.txt", "")
        core = repo.core()
        core.start()
        cls.files = {f["path"]: f for f in core.diff()["files"]}

    @classmethod
    def tearDownClass(cls):
        cls.repo.cleanup()

    def test_add(self):
        f = self.files["added.txt"]
        self.assertEqual((f["status"], f["additions"], f["deletions"]), ("A", 2, 0))
        self.assertEqual([(l["type"], l["new"], l["text"]) for l in f["hunks"][0]["lines"]],
                         [("add", 1, "x"), ("add", 2, "y")])

    def test_modify(self):
        f = self.files["modify.txt"]
        self.assertEqual((f["status"], f["additions"], f["deletions"]), ("M", 1, 1))
        hunk = f["hunks"][0]
        self.assertTrue(hunk["header"].startswith("@@ -2,7 +2,7 @@"))
        dels = [l for l in hunk["lines"] if l["type"] == "del"]
        adds = [l for l in hunk["lines"] if l["type"] == "add"]
        self.assertEqual((dels[0]["old"], dels[0]["text"]), (5, "line 5"))
        self.assertEqual((adds[0]["new"], adds[0]["text"]), (5, "line five"))
        ctx = hunk["lines"][0]
        self.assertEqual((ctx["type"], ctx["old"], ctx["new"]), ("ctx", 2, 2))

    def test_delete(self):
        f = self.files["delete.txt"]
        self.assertEqual((f["status"], f["deletions"], f["oldPath"]), ("D", 1, "delete.txt"))

    def test_rename_with_space(self):
        f = self.files["new name.txt"]
        self.assertEqual((f["status"], f["oldPath"], f["hunks"]), ("R", "old_name.txt", []))

    def test_binary(self):
        f = self.files["image.bin"]
        self.assertTrue(f["binary"])
        self.assertEqual(f["hunks"], [])

    def test_no_newline_at_end(self):
        f = self.files["noeol.txt"]
        hl = f["hunks"][0]["lines"]
        self.assertEqual([(l["type"], l["text"], l.get("noeol", False)) for l in hl],
                         [("ctx", "a", False), ("del", "b", True), ("add", "c", True)])

    def test_empty_file(self):
        f = self.files["empty.txt"]
        self.assertEqual((f["status"], f["hunks"], f["binary"]), ("A", [], False))

    def test_quoted_paths(self):
        text = ('diff --git "a/t\\tab.txt" "b/t\\tab.txt"\n'
                'new file mode 100644\n'
                'index 0000000..e69de29\n'
                'diff --git a/x b/y z\n'
                'similarity index 100%\n'
                'rename from x\n'
                'rename to "y z"\n')
        files = review.parse_diff(text)
        self.assertEqual(files[0]["path"], "t\tab.txt")
        self.assertEqual((files[1]["oldPath"], files[1]["path"]), ("x", "y z"))

    def test_collect_range(self):
        f = self.files["modify.txt"]
        self.assertEqual(review.collect_range(f, "new", 4, 6), ["line 4", "line five", "line 6"])
        self.assertEqual(review.collect_range(f, "old", 5, 5), ["line 5"])
        self.assertIsNone(review.collect_range(f, "old", 4, 5))  # line 4 is context, not deleted
        self.assertIsNone(review.collect_range(f, "new", 8, 12))  # runs past the hunk


if __name__ == "__main__":
    unittest.main()
