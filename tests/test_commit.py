import os
import stat
import unittest

from helpers import TempRepo, lines, review


class CommitTest(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.repo.write("a.txt", lines(5))
        self.repo.commit("base")
        self.head = self.repo.git("rev-parse", "HEAD").strip()
        self.repo.write("a.txt", lines(5).replace("line 2\n", "two\n"))
        self.repo.write("new.txt", "untracked\n")
        self.core = self.repo.core()
        self.core.start()
        self.approved_tree = self.repo.git("rev-parse", self.core.review["rounds"][-1]["commit"] + "^{tree}").strip()

    def tearDown(self):
        self.repo.cleanup()

    def approve_commit(self):
        self.core.submit({"verdict": "approve_commit"})
        return self.core.wait(0)

    def assert_untouched(self, index_before):
        self.assertEqual(self.repo.git("rev-parse", "HEAD").strip(), self.head)
        self.assertEqual(self.repo.git("ls-files", "-s"), index_before)

    def test_commits_approved_snapshot(self):
        self.assertEqual(self.approve_commit(), "APPROVED round=1 commit=requested")
        out = self.core.commit("Rename line two\n\nAdds new.txt too.\n")
        sha = self.repo.git("rev-parse", "HEAD").strip()
        self.assertEqual(out, "committed %s on main" % sha[:7])
        self.assertEqual(self.repo.git("rev-parse", "HEAD^").strip(), self.head)
        self.assertEqual(self.repo.git("rev-parse", "HEAD^{tree}").strip(), self.approved_tree)
        self.assertEqual(self.repo.git("log", "-1", "--format=%an|%B").strip(), "Test|Rename line two\n\nAdds new.txt too.")
        self.assertEqual(self.repo.git("status", "--porcelain"), "")
        self.assertEqual(self.repo.git("for-each-ref", "refs/local-review"), "")
        self.assertIsNone(self.core.review)
        self.assertEqual(self.core.payload()["lastResult"], out)

    def test_plain_approve_does_not_allow_commit(self):
        self.core.submit({"verdict": "approve"})
        self.assertEqual(self.core.wait(0), "APPROVED round=1")
        with self.assertRaises(review.ReviewError):
            self.core.commit("msg")

    def test_working_tree_changed_after_approval(self):
        self.approve_commit()
        self.repo.write("a.txt", "something else\n")
        before = self.repo.git("ls-files", "-s")
        with self.assertRaises(review.ReviewError) as cm:
            self.core.commit("msg")
        self.assertIn("approved snapshot", str(cm.exception))
        self.assert_untouched(before)
        self.assertEqual(self.core.review["status"], "approved")

    def test_branch_moved(self):
        self.approve_commit()
        self.repo.git("commit", "-q", "--allow-empty", "-m", "moved")
        with self.assertRaises(review.ReviewError) as cm:
            self.core.commit("msg")
        self.assertIn("moved", str(cm.exception))

    def test_branch_switched_rejected_at_submit(self):
        self.repo.git("checkout", "-q", "-b", "other")
        with self.assertRaises(review.ReviewError) as cm:
            self.core.submit({"verdict": "approve_commit"})
        self.assertIn("not checked out", str(cm.exception))
        self.assertEqual(self.core.review["status"], "pending_review")

    def test_failing_hook_restores_index(self):
        self.repo.write("staged.txt", "partially staged\n")
        self.repo.git("add", "staged.txt")
        self.repo.remove("staged.txt")
        self.repo.write("staged.txt", "partially staged\n")
        self.core.end()
        self.core.start()
        self.approve_commit()
        hook = os.path.join(self.repo.dir, ".git", "hooks", "pre-commit")
        with open(hook, "w") as f:
            f.write("#!/bin/sh\necho 'lint failed' >&2\nexit 1\n")
        os.chmod(hook, os.stat(hook).st_mode | stat.S_IEXEC)
        before = self.repo.git("ls-files", "-s")
        with self.assertRaises(review.ReviewError) as cm:
            self.core.commit("msg")
        self.assertIn("lint failed", str(cm.exception))
        self.assert_untouched(before)
        self.assertEqual(self.core.review["commitError"], "git failed: lint failed")

        os.unlink(hook)
        self.assertTrue(self.core.commit("msg").startswith("committed "))


class DetachedTest(unittest.TestCase):
    def test_detached_head_cannot_commit(self):
        repo = TempRepo()
        try:
            repo.write("a.txt", "a\n")
            repo.commit()
            repo.git("checkout", "-q", "--detach")
            repo.write("a.txt", "b\n")
            core = repo.core()
            core.start()
            with self.assertRaises(review.ReviewError):
                core.submit({"verdict": "approve_commit"})
        finally:
            repo.cleanup()


if __name__ == "__main__":
    unittest.main()
