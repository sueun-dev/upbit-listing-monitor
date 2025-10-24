#!/usr/bin/env python3
"""
Auto-updating static server for the Upbit listing dashboard.

- Runs `scripts/update_crix_master.py` immediately on startup and then every N seconds.
- Serves the project directory via a simple HTTP server so clients receive the latest snapshot.

Usage:
    python3 server.py --port 8009 --master-interval 7200 --price-interval 600

Stop with Ctrl+C.
"""

from __future__ import annotations

import argparse
import functools
import logging
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scripts import update_crix_master, update_price_cache

DEFAULT_MASTER_INTERVAL = 2 * 60 * 60  # 2 hours
DEFAULT_PRICE_INTERVAL = 10 * 60  # 10 minutes
DEFAULT_PORT = 8000
PROJECT_ROOT = Path(__file__).resolve().parent
SNAPSHOT_PATH = PROJECT_ROOT / "crix_master.json"
PRICE_CACHE_PATH = PROJECT_ROOT / "price_cache.json"


class QuietHTTPRequestHandler(SimpleHTTPRequestHandler):
    """Silence default logging to keep console output clean."""

    def log_message(self, format: str, *args) -> None:  # noqa: D401 (documented in base class)
        logging.info("HTTP %s - %s", self.address_string(), format % args)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        logging.error("HTTP error %s: %s", code, message or HTTPStatus(code).phrase)
        super().send_error(code, message, explain)


def run_master_update(master_path: Path) -> int:
    logging.info("Updating listing master (%s)...", master_path)
    result = update_crix_master.sync_crix_master(master_path)
    if result == 0:
        logging.info("Listing master updated.")
    else:
        logging.warning("Listing master update exited with code %s.", result)
    return result


def run_price_update(
    master_path: Path,
    price_path: Path,
    *,
    lookback_days: int,
    concurrency: int,
    candle_count: int,
) -> int:
    logging.info("Updating price cache (%s)...", price_path)
    result = update_price_cache.sync_price_cache(
        master_path,
        price_path,
        lookback_days=lookback_days,
        concurrency=concurrency,
        candle_count=candle_count,
    )
    if result == 0:
        logging.info("Price cache updated.")
    else:
        logging.warning("Price cache update exited with code %s.", result)
    return result


def schedule_task(name: str, func, interval: int, stop_event: threading.Event) -> threading.Thread:
    """Start a background thread that repeatedly executes `func`."""

    def worker() -> None:
        while not stop_event.is_set():
            start = time.time()
            func()
            elapsed = time.time() - start
            remaining = max(0, interval - elapsed)
            logging.debug("[%s] Next run in %.0f seconds.", name, remaining)
            if stop_event.wait(remaining):
                break

    thread = threading.Thread(target=worker, daemon=True, name=name)
    thread.start()
    return thread


def serve(directory: Path, port: int, bind: str) -> None:
    handler_class = functools.partial(QuietHTTPRequestHandler, directory=str(directory))
    httpd = ThreadingHTTPServer((bind, port), handler_class)
    logging.info("Serving %s at http://%s:%s (Ctrl+C to stop)", directory, bind, port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logging.info("Shutting down server...")
    finally:
        httpd.server_close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve dashboard with automatic Upbit listing updates.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to serve on (default: {DEFAULT_PORT})")
    parser.add_argument(
        "--bind",
        default="0.0.0.0",
        help='IP address to bind (default: "0.0.0.0" for all interfaces)',
    )
    parser.add_argument("--master-interval", type=int, default=DEFAULT_MASTER_INTERVAL, help="Seconds between listing master refreshes (default ≈ 2h).")
    parser.add_argument("--price-interval", type=int, default=DEFAULT_PRICE_INTERVAL, help="Seconds between price cache refreshes (default ≈ 10m).")
    parser.add_argument(
        "--directory",
        default=str(PROJECT_ROOT),
        help=f"Directory to serve (default: {PROJECT_ROOT})",
    )
    parser.add_argument(
        "--output",
        "--master-output",
        dest="master_output",
        default=str(SNAPSHOT_PATH),
        help=f"Snapshot file path (default: {SNAPSHOT_PATH})",
    )
    parser.add_argument(
        "--price-output",
        default=str(PRICE_CACHE_PATH),
        help=f"Price cache output path (default: {PRICE_CACHE_PATH})",
    )
    parser.add_argument(
        "--price-lookback",
        type=int,
        default=update_price_cache.DEFAULT_LOOKBACK_DAYS,
        help=f"Lookback days for price cache (default: {update_price_cache.DEFAULT_LOOKBACK_DAYS})",
    )
    parser.add_argument(
        "--price-concurrency",
        type=int,
        default=update_price_cache.DEFAULT_CONCURRENCY,
        help=f"Parallel price fetch workers (default: {update_price_cache.DEFAULT_CONCURRENCY})",
    )
    parser.add_argument(
        "--price-count",
        type=int,
        default=update_price_cache.MAX_CANDLES,
        help=f"Candle count per coin (max {update_price_cache.MAX_CANDLES})",
    )
    parser.add_argument("--log-level", default="INFO", help="Logging level (default: INFO)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    directory = Path(args.directory).resolve()
    master_path = Path(args.master_output).resolve()
    price_path = Path(args.price_output).resolve()
    directory.mkdir(parents=True, exist_ok=True)

    stop_event = threading.Event()

    # Run initial updates.
    run_master_update(master_path)
    run_price_update(
        master_path,
        price_path,
        lookback_days=args.price_lookback,
        concurrency=args.price_concurrency,
        candle_count=min(args.price_count, update_price_cache.MAX_CANDLES),
    )

    schedule_task(
        "master-updater",
        functools.partial(run_master_update, master_path),
        args.master_interval,
        stop_event,
    )
    schedule_task(
        "price-updater",
        functools.partial(
            run_price_update,
            master_path,
            price_path,
            lookback_days=args.price_lookback,
            concurrency=args.price_concurrency,
            candle_count=min(args.price_count, update_price_cache.MAX_CANDLES),
        ),
        args.price_interval,
        stop_event,
    )

    try:
        serve(directory, args.port, args.bind)
    finally:
        stop_event.set()


if __name__ == "__main__":  # pragma: no cover
    main()
