import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock
from urllib.error import URLError

from scripts import update_crix_master as updater


class UpdateCrixMasterTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="crix-test-"))
        self.output = self.tmpdir / "crix_master.json"

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_sync_creates_snapshot_and_reports_new_codes(self):
        remote_payload = [
            {"code": "CRIX.UPBIT.KRW-AAA", "listingDate": "2024-01-01"},
            {"code": "CRIX.UPBIT.KRW-BBB", "listingDate": "2024-02-01"},
        ]

        with mock.patch.object(updater, "read_remote", return_value=remote_payload):
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                exit_code = updater.sync_crix_master(self.output)

        self.assertEqual(exit_code, 0)
        self.assertTrue(self.output.exists())
        self.assertEqual(json.loads(self.output.read_text()), remote_payload)
        output_text = buffer.getvalue()
        self.assertIn("2 new listing(s)", output_text)
        self.assertIn("Snapshot updated", output_text)

    def test_sync_detects_no_changes(self):
        payload = [{"code": "CRIX.UPBIT.KRW-CCC", "listingDate": "2024-03-03"}]
        self.output.write_text(json.dumps(payload), encoding="utf-8")

        with mock.patch.object(updater, "read_remote", return_value=payload):
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                exit_code = updater.sync_crix_master(self.output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(self.output.read_text()), payload)
        self.assertIn("No changes detected", buffer.getvalue())

    def test_sync_handles_network_errors(self):
        with mock.patch.object(updater, "read_remote", side_effect=URLError("timeout")):
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                exit_code = updater.sync_crix_master(self.output)

        self.assertEqual(exit_code, 1)
        self.assertIn("Network error", stderr.getvalue())
        self.assertFalse(self.output.exists())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
