"""Shared test helpers: load the `review` script as a module and build throwaway repos."""

import http.client
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "review")
GOLDEN = os.path.join(ROOT, "tests", "golden")

# Keep the user's git config out of the tests.
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ["GIT_CONFIG_GLOBAL"] = os.devnull


def load_review():
    loader = importlib.machinery.SourceFileLoader("review_mod", SCRIPT)
    spec = importlib.util.spec_from_loader("review_mod", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["review_mod"] = mod
    loader.exec_module(mod)
    return mod


review = load_review()


class TempRepo:
    def __init__(self):
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="lr-test-"))
        self.git("init", "-q")
        self.git("symbolic-ref", "HEAD", "refs/heads/main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "commit.gpgsign", "false")

    def git(self, *args, env=None):
        full = dict(os.environ, **(env or {}))
        p = subprocess.run(["git"] + list(args), cwd=self.dir, env=full,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        return p.stdout.decode()

    def write(self, path, content):
        full = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(full, mode) as f:
            f.write(content)

    def remove(self, path):
        os.unlink(os.path.join(self.dir, path))

    def commit(self, msg="commit"):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    def core(self):
        return review.Core(review.Repo(self.dir))

    def cli(self, *args, input=None, timeout=60):
        return subprocess.run([sys.executable, SCRIPT] + list(args), cwd=self.dir, input=input,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                              universal_newlines=True)

    def server_info(self):
        with open(os.path.join(self.dir, ".git", "local-review", "server.json")) as f:
            return json.load(f)

    def http(self, method, path, body=None, headers=None, raw=None, token=True):
        info = self.server_info()
        conn = http.client.HTTPConnection("127.0.0.1", info["port"], timeout=30)
        hdrs = {}
        if token:
            hdrs["Authorization"] = "Bearer " + info["token"]
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        hdrs.update(headers or {})
        try:
            conn.request(method, path, body=data, headers=hdrs)
            resp = conn.getresponse()
            payload = resp.read().decode()
            ctype = resp.getheader("Content-Type", "")
            return resp.status, (json.loads(payload) if ctype.startswith("application/json") else payload)
        finally:
            conn.close()

    def stop(self):
        try:
            self.cli("stop", timeout=20)
        except Exception:
            pass
        try:
            info = self.server_info()
            os.kill(info["pid"], 9)
        except (OSError, ValueError, KeyError):
            pass

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def lines(n, prefix="line"):
    return "".join("%s %d\n" % (prefix, i) for i in range(1, n + 1))
