import unittest

from helpers import TempRepo, review


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.repo.write(".gitignore", "*.log\n")
        self.repo.write("tracked.txt", "one\n")
        self.repo.commit()

    def tearDown(self):
        self.repo.cleanup()

    def test_untracked_included_ignored_excluded_index_untouched(self):
        self.repo.write("tracked.txt", "one\ntwo\n")
        self.repo.write("new/untracked.txt", "hello\n")
        self.repo.write("debug.log", "noise\n")
        self.repo.write("staged.txt", "staged\n")
        self.repo.git("add", "staged.txt")
        before = self.repo.git("ls-files", "-s")
        status_before = self.repo.git("status", "--porcelain")

        core = self.repo.core()
        core.start()
        paths = {f["path"]: f["status"] for f in core.diff()["files"]}

        self.assertEqual(paths, {"tracked.txt": "M", "new/untracked.txt": "A", "staged.txt": "A"})
        self.assertEqual(self.repo.git("ls-files", "-s"), before)
        self.assertEqual(self.repo.git("status", "--porcelain"), status_before)

    def test_round_ref_written_and_no_changes_rejected(self):
        core = self.repo.core()
        with self.assertRaises(review.ReviewError) as cm:
            core.start()
        self.assertIn("no changes", str(cm.exception))
        self.assertEqual(self.repo.git("for-each-ref", "refs/local-review"), "")
        self.assertIsNone(core.review)

        self.repo.write("tracked.txt", "changed\n")
        core.start()
        refs = self.repo.git("for-each-ref", "--format=%(refname)", "refs/local-review").split()
        self.assertEqual(refs, ["refs/local-review/%s/round-1" % core.review["id"]])

    def test_base_ref_uses_merge_base(self):
        self.repo.git("checkout", "-q", "-b", "feature")
        self.repo.write("feature.txt", "f\n")
        self.repo.commit("feature")
        core = self.repo.core()
        core.start("main")
        self.assertEqual([f["path"] for f in core.diff()["files"]], ["feature.txt"])
        main_sha = self.repo.git("rev-parse", "main").strip()
        self.assertEqual(core.review["base"], main_sha)

    def test_bad_ref_rejected(self):
        self.repo.write("tracked.txt", "changed\n")
        with self.assertRaises(review.ReviewError):
            self.repo.core().start("--output=/tmp/x")


if __name__ == "__main__":
    unittest.main()
