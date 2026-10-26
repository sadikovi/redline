"""End-to-end tests through the real CLI and a detached server."""

import os
import subprocess
import sys
import time
import unittest

from helpers import SCRIPT, TempRepo, lines


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.repo.write("a.txt", lines(10))
        self.repo.commit()
        self.repo.write("a.txt", lines(10).replace("line 3\n", "three\n"))
        p = self.repo.cli("start", "--no-open")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.start_line = p.stdout.strip()

    def tearDown(self):
        self.repo.stop()
        self.repo.cleanup()

    def comment(self, start=3, body="please fix"):
        status, c = self.repo.http("POST", "/api/comments",
                                   {"path": "a.txt", "side": "new", "start": start, "end": start, "body": body})
        self.assertEqual(status, 200, c)
        return c

    def submit(self, verdict="request_changes"):
        status, body = self.repo.http("POST", "/api/submit", {"verdict": verdict})
        self.assertEqual(status, 200, body)


class CliTest(ServerTestCase):
    def test_start_output_and_status(self):
        info = self.repo.server_info()
        self.assertRegex(self.start_line, r"^review [0-9a-f]{6} round 1 http://127\.0\.0\.1:%d/#t=%s$"
                         % (info["port"], info["token"]))
        self.assertEqual(os.stat(os.path.join(self.repo.dir, ".git", "local-review", "server.json")).st_mode & 0o777, 0o600)
        p = self.repo.cli("status")
        self.assertRegex(p.stdout, r"^[0-9a-f]{6} round 1 pending_review open=0\n$")

    def test_full_round_trip(self):
        self.comment()
        self.submit()
        p = self.repo.cli("wait", "--timeout", "5")
        self.assertEqual(p.returncode, 0)
        self.assertTrue(p.stdout.startswith("CHANGES_REQUESTED round=1 comments=1\n#1 a.txt:+3\n> three\n"))
        self.repo.write("a.txt", lines(10).replace("line 3\n", "THREE\n"))
        p = self.repo.cli("push", input="#1 resolve: Uppercased.\n")
        self.assertEqual((p.returncode, p.stdout), (0, "round 2 ok\n"), p.stderr)
        status, data = self.repo.http("GET", "/api/diff?round=2&since=1")
        self.assertEqual(status, 200)
        self.assertEqual([l["text"] for l in data["files"][0]["hunks"][0]["lines"] if l["type"] != "ctx"],
                         ["three", "THREE"])
        self.submit("approve")
        p = self.repo.cli("wait", "--timeout", "5")
        self.assertEqual(p.stdout, "APPROVED round=2\n")
        self.assertEqual(self.repo.git("diff", "--cached", "--name-only"), "")

    def test_wait_timeout_exit_code(self):
        p = self.repo.cli("wait", "--timeout", "1")
        self.assertEqual((p.returncode, p.stdout), (2, "TIMEOUT\n"))

    def test_errors_are_one_line(self):
        p = self.repo.cli("push", input="#1 resolve\n")
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, "")
        self.assertEqual(len(p.stderr.strip().splitlines()), 1)

    def test_end(self):
        rid = self.start_line.split()[1]
        p = self.repo.cli("end")
        self.assertEqual(p.stdout, "ended %s\n" % rid)
        self.assertEqual(self.repo.git("for-each-ref", "refs/local-review"), "")
        self.assertTrue(os.path.exists(os.path.join(self.repo.dir, ".git", "local-review", "archive", rid + ".json")))


class SecurityTest(ServerTestCase):
    def test_token_required(self):
        self.assertEqual(self.repo.http("GET", "/api/review", token=False)[0], 401)
        self.assertEqual(self.repo.http("GET", "/api/review", headers={"Authorization": "Bearer nope"})[0], 401)
        self.assertEqual(self.repo.http("GET", "/api/review")[0], 200)

    def test_foreign_host(self):
        self.assertEqual(self.repo.http("GET", "/api/review", headers={"Host": "evil.example:80"})[0], 403)
        self.assertEqual(self.repo.http("GET", "/", headers={"Host": "evil.example"})[0], 403)

    def test_foreign_origin_on_post(self):
        body = {"path": "a.txt", "side": "new", "start": 3, "end": 3, "body": "x"}
        status, _ = self.repo.http("POST", "/api/comments", body, headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        port = self.repo.server_info()["port"]
        status, _ = self.repo.http("POST", "/api/comments", body, headers={"Origin": "http://localhost:%d" % port})
        self.assertEqual(status, 200)

    def test_non_json_post(self):
        status, _ = self.repo.http("POST", "/api/submit", raw=b"verdict=approve",
                                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 415)

    def test_static_has_csp_and_no_token_needed(self):
        status, body = self.repo.http("GET", "/", token=False)
        self.assertEqual(status, 200)
        self.assertIn("<title>", body)

    def test_invalid_comment_path_rejected(self):
        status, _ = self.repo.http("POST", "/api/comments",
                                   {"path": "../etc/passwd", "side": "new", "start": 1, "end": 1, "body": "x"})
        self.assertEqual(status, 400)


class ConcurrencyTest(ServerTestCase):
    def test_wait_wakes_within_a_second(self):
        self.comment()
        proc = subprocess.Popen([sys.executable, SCRIPT, "wait", "--timeout", "30"], cwd=self.repo.dir,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(1.0)
        self.assertIsNone(proc.poll())
        t0 = time.monotonic()
        self.submit()
        out, _ = proc.communicate(timeout=10)
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertTrue(out.decode().startswith("CHANGES_REQUESTED round=1 comments=1"))


class RecoveryTest(ServerTestCase):
    def test_server_killed_mid_review(self):
        self.comment(body="draft survives")
        old = self.repo.server_info()
        os.kill(old["pid"], 9)
        time.sleep(0.2)
        p = self.repo.cli("status")
        self.assertEqual(p.returncode, 0, p.stderr)
        new = self.repo.server_info()
        self.assertNotEqual(new["pid"], old["pid"])
        self.assertNotEqual(new["token"], old["token"])
        status, data = self.repo.http("GET", "/api/review")
        self.assertEqual(status, 200)
        self.assertEqual([(c["state"], c["thread"][0]["body"]) for c in data["review"]["comments"]],
                         [("draft", "draft survives")])

    def test_consumed_without_push_is_redelivered(self):
        self.comment()
        self.submit()
        first = self.repo.cli("wait", "--timeout", "5").stdout
        self.assertEqual(self.repo.cli("wait", "--timeout", "1").stdout, "TIMEOUT\n")
        p = self.repo.cli("start", "--no-open")
        self.assertRegex(p.stdout, r"^resumed [0-9a-f]{6} round 1 changes_requested comments=1 http://")
        self.assertEqual(self.repo.cli("wait", "--timeout", "5").stdout, first)

    def test_resume_pending(self):
        p = self.repo.cli("start", "--no-open")
        self.assertRegex(p.stdout, r"^resumed [0-9a-f]{6} round 1 pending_review http://")


class CleanupTest(ServerTestCase):
    def refs(self):
        return self.repo.git("for-each-ref", "--format=%(refname)", "refs/local-review").split()

    def test_start_after_approval_and_orphans(self):
        old_id = self.start_line.split()[1]
        orphan = "refs/local-review/dead00/round-1"
        self.repo.git("update-ref", orphan, "HEAD")
        self.submit("approve")
        self.repo.write("a.txt", lines(10).replace("line 4\n", "four\n"))
        p = self.repo.cli("start", "--no-open")
        self.assertRegex(p.stdout, r"^review [0-9a-f]{6} round 1 ")
        new_id = p.stdout.split()[1]
        self.assertNotEqual(new_id, old_id)
        self.assertEqual(self.refs(), ["refs/local-review/%s/round-1" % new_id])

    def test_start_new_discards(self):
        p = self.repo.cli("start", "--no-open", "--new")
        self.assertRegex(p.stdout, r"^review ")
        self.assertEqual(len(self.refs()), 1)


if __name__ == "__main__":
    unittest.main()
