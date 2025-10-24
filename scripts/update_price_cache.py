#!/usr/bin/env python3
"""
Generate a cached price snapshot for recently listed Upbit KRW markets.

The frontend consumes this file instead of querying the Upbit API directly,
allowing the server to control API usage (e.g. refresh every 10 minutes).
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from gzip import decompress
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


USER_AGENT = "UpbitListingMonitor/1.0 (+https://upbit.com)"
CANDLES_URL = "https://crix-api.upbit.com/v1/crix/candles/days?code={code}&count={count}"
MAX_CANDLES = 400  # Upbit hard limit for daily candles per request
DEFAULT_LOOKBACK_DAYS = 380  # Slightly > 12 months
DEFAULT_CONCURRENCY = 5

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MASTER = PROJECT_ROOT / "crix_master.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "price_cache.json"


@dataclass
class CoinMeta:
    code: str
    pair: str
    korean_name: str
    english_name: str
    listing_date: datetime


def utc_now() -> datetime:
    return datetime.utcnow().replace(microsecond=0, tzinfo=timezone.utc)


def load_master(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Master file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_listing_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def select_recent_coins(master_payload: Sequence[Dict[str, Any]], lookback_days: int) -> List[CoinMeta]:
    reference_now = utc_now()
    threshold = reference_now - timedelta(days=lookback_days)
    coins: List[CoinMeta] = []
    for record in master_payload:
        listing_date_str = record.get("listingDate")
        if (
            record.get("exchange") == "UPBIT"
            and record.get("quoteCurrencyCode") == "KRW"
            and record.get("marketState") == "ACTIVE"
            and listing_date_str
        ):
            try:
                listing_date = parse_listing_date(listing_date_str)
            except ValueError:
                continue
            if listing_date <= reference_now and listing_date >= threshold:
                coins.append(
                    CoinMeta(
                        code=record["code"],
                        pair=record.get("pair") or record["code"].split(".", 2)[-1].replace("-", "/"),
                        korean_name=record.get("koreanName") or record.get("localName") or record.get("baseCurrencyCode") or "",
                        english_name=record.get("englishName") or "",
                        listing_date=listing_date,
                    )
                )
    coins.sort(key=lambda meta: meta.listing_date, reverse=True)
    return coins


def fetch_candles(code: str, count: int = MAX_CANDLES, timeout: int = 30) -> List[Dict[str, Any]]:
    url = CANDLES_URL.format(code=code, count=count)
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = decompress(body)
        payload = json.loads(body.decode("utf-8"))
        if not isinstance(payload, list):
            raise ValueError(f"Unexpected response for {code}")
        return payload


def parse_candle_datetime(value: str) -> datetime:
    # Upbit returns ISO8601 with timezone (+00:00)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def build_coin_snapshot(coin: CoinMeta, candles: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    if not candles:
        raise ValueError("No candle data")

    chronological = list(reversed(candles))
    relevant = [
        candle
        for candle in chronological
        if parse_candle_datetime(candle["candleDateTime"]) >= coin.listing_date
    ]
    if not relevant:
        relevant = chronological

    prices = [float(candle["tradePrice"]) for candle in relevant if candle.get("tradePrice") is not None]
    if not prices:
        raise ValueError("No valid price points")

    listing_price = prices[0]
    current_price = prices[-1]
    change = ((current_price - listing_price) / listing_price * 100) if listing_price else 0.0

    return {
        "status": "ok",
        "code": coin.code,
        "pair": coin.pair,
        "koreanName": coin.korean_name,
        "englishName": coin.english_name,
        "listingDate": coin.listing_date.date().isoformat(),
        "listingPrice": listing_price,
        "currentPrice": current_price,
        "change": change,
        "prices": prices,
        "lastCandleAt": relevant[-1]["candleDateTime"],
        "points": len(prices),
    }


def build_error_snapshot(coin: CoinMeta, error: Exception | str) -> Dict[str, Any]:
    message = str(error)
    return {
        "status": "error",
        "code": coin.code,
        "pair": coin.pair,
        "koreanName": coin.korean_name,
        "englishName": coin.english_name,
        "listingDate": coin.listing_date.date().isoformat(),
        "error": message,
    }


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temp_path.replace(path)


def sync_price_cache(
    master_path: Path,
    output_path: Path,
    *,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    concurrency: int = DEFAULT_CONCURRENCY,
    candle_count: int = MAX_CANDLES,
) -> int:
    try:
        master_payload = load_master(master_path)
    except FileNotFoundError as error:
        print(f"[price-cache] {error}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as error:
        print(f"[price-cache] Invalid master JSON: {error}", file=sys.stderr)
        return 1

    coins = select_recent_coins(master_payload, lookback_days)
    if not coins:
        payload = {"generatedAt": utc_now().isoformat(), "coins": []}
        write_json(output_path, payload)
        print("[price-cache] No recent coins found. Snapshot cleared.")
        return 0

    print(f"[price-cache] Preparing {len(coins)} coin(s) within {lookback_days} days.")

    results: List[Dict[str, Any]] = []
    errors = 0

    def worker(meta: CoinMeta) -> Dict[str, Any]:
        candles = fetch_candles(meta.code, count=candle_count)
        return build_coin_snapshot(meta, candles)

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as executor:
        future_map = {executor.submit(worker, coin): coin for coin in coins}
        for future in as_completed(future_map):
            coin = future_map[future]
            try:
                snapshot = future.result()
                results.append(snapshot)
                print(f"[price-cache] ✔ {coin.code} ({snapshot['points']} pts)")
            except (HTTPError, URLError) as network_error:
                errors += 1
                error_snapshot = build_error_snapshot(coin, network_error)
                results.append(error_snapshot)
                print(f"[price-cache] ✖ {coin.code} network error: {network_error}", file=sys.stderr)
            except Exception as error:  # pragma: no cover - defensive
                errors += 1
                error_snapshot = build_error_snapshot(coin, error)
                results.append(error_snapshot)
                print(f"[price-cache] ✖ {coin.code} error: {error}", file=sys.stderr)

    results.sort(key=lambda item: item.get("listingDate", ""), reverse=True)
    payload = {"generatedAt": utc_now().isoformat(), "coins": results}
    write_json(output_path, payload)

    if errors:
        print(f"[price-cache] Completed with {errors} error(s).")
    else:
        print("[price-cache] Snapshot updated successfully.")
    return 0 if errors == 0 else 2


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update cached Upbit price data for recent listings.")
    parser.add_argument(
        "--master",
        default=str(DEFAULT_MASTER),
        help=f"Path to crix_master.json (default: {DEFAULT_MASTER})",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Output file path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=DEFAULT_LOOKBACK_DAYS,
        help=f"Number of days to keep (default: {DEFAULT_LOOKBACK_DAYS})",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"Concurrent fetch workers (default: {DEFAULT_CONCURRENCY})",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=MAX_CANDLES,
        help=f"Number of candles to request per coin (default/max: {MAX_CANDLES})",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    master_path = Path(args.master).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    return sync_price_cache(
        master_path,
        output_path,
        lookback_days=args.lookback_days,
        concurrency=args.concurrency,
        candle_count=min(args.count, MAX_CANDLES),
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
