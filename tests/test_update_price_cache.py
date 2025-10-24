import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest import mock

from scripts import update_price_cache as price_cache


class UpdatePriceCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="price-cache-test-"))
        self.master_path = self.tmpdir / "crix_master.json"
        self.output_path = self.tmpdir / "price_cache.json"

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def write_master(self, records):
        self.master_path.write_text(json.dumps(records), encoding="utf-8")

    def test_sync_price_cache_success(self):
        now = datetime(2025, 10, 24, tzinfo=timezone.utc)
        with mock.patch.object(price_cache, "utc_now", return_value=now):
            self.write_master(
                [
                    {
                        "code": "CRIX.UPBIT.KRW-AAA",
                        "pair": "AAA/KRW",
                        "koreanName": "AAA",
                        "englishName": "TripleA",
                        "exchange": "UPBIT",
                        "quoteCurrencyCode": "KRW",
                        "marketState": "ACTIVE",
                        "listingDate": "2025-10-20",
                    }
                ]
            )

            candles = [
                {"candleDateTime": "2025-10-21T00:00:00+00:00", "tradePrice": 12},  # newest first (Upbit behaviour)
                {"candleDateTime": "2025-10-20T00:00:00+00:00", "tradePrice": 10},
            ]

            with mock.patch.object(price_cache, "fetch_candles", return_value=candles):
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = price_cache.sync_price_cache(
                        self.master_path,
                        self.output_path,
                        lookback_days=30,
                        concurrency=1,
                    )

        self.assertEqual(exit_code, 0)
        payload = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(len(payload["coins"]), 1)
        coin = payload["coins"][0]
        self.assertEqual(coin["code"], "CRIX.UPBIT.KRW-AAA")
        self.assertEqual(coin["listingPrice"], 10)
        self.assertEqual(coin["currentPrice"], 12)
        self.assertAlmostEqual(coin["change"], 20.0)
        self.assertEqual(coin["prices"], [10.0, 12.0])

    def test_sync_price_cache_handles_errors(self):
        now = datetime(2025, 10, 24, tzinfo=timezone.utc)
        with mock.patch.object(price_cache, "utc_now", return_value=now):
            self.write_master(
                [
                    {
                        "code": "CRIX.UPBIT.KRW-ERR",
                        "pair": "ERR/KRW",
                        "koreanName": "에러",
                        "englishName": "Error",
                        "exchange": "UPBIT",
                        "quoteCurrencyCode": "KRW",
                        "marketState": "ACTIVE",
                        "listingDate": "2025-10-22",
                    }
                ]
            )

            with mock.patch.object(price_cache, "fetch_candles", side_effect=RuntimeError("boom")):
                stdout = io.StringIO()
                stderr = io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    exit_code = price_cache.sync_price_cache(
                        self.master_path,
                        self.output_path,
                        lookback_days=30,
                        concurrency=1,
                    )

        self.assertEqual(exit_code, 2)
        payload = json.loads(self.output_path.read_text(encoding="utf-8"))
        coin = payload["coins"][0]
        self.assertEqual(coin["status"], "error")
        self.assertIn("boom", coin["error"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
