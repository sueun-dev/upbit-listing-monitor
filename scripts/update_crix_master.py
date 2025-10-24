#!/usr/bin/env python3
"""
Fetch the latest Upbit listing master JSON and update the local snapshot.

Intended to be run on the server every ~2 hours (e.g. via cron/systemd timer).
The script compares the remote payload with the existing file, reports any new
coin codes, and always keeps `crix_master.json` current for the frontend.
"""

from __future__ import annotations

import argparse
import json
import sys
from gzip import decompress
from pathlib import Path
from typing import Iterable, List, Sequence
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen


CRIX_MASTER_URL = "https://crix-static.upbit.com/v2/crix_master"
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "crix_master.json"
USER_AGENT = "UpbitListingMonitor/1.0 (+https://upbit.com)"


def read_remote(url: str) -> Sequence[dict]:
    """Download the JSON payload from Upbit."""
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
        },
    )
    with urlopen(request, timeout=30) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = decompress(body)
        return json.loads(body.decode("utf-8"))


def read_local(path: Path) -> Sequence[dict]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def extract_codes(records: Iterable[dict]) -> set:
    return {record.get("code") for record in records if record.get("code")}


def write_json(path: Path, payload: Sequence[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def sync_crix_master(output: Path) -> int:
    try:
        remote_payload = read_remote(CRIX_MASTER_URL)
    except HTTPError as error:
        print(f"[update-crix] HTTP error: {error.code} {error.reason}", file=sys.stderr)
        return 1
    except URLError as error:
        print(f"[update-crix] Network error: {error.reason}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover - defensive
        print(f"[update-crix] Unexpected error: {error}", file=sys.stderr)
        return 1

    local_payload = read_local(output)
    remote_codes = extract_codes(remote_payload)
    local_codes = extract_codes(local_payload)

    new_codes = sorted(remote_codes - local_codes)
    removed_codes = sorted(local_codes - remote_codes)

    if new_codes:
        print(f"[update-crix] {len(new_codes)} new listing(s): {', '.join(new_codes)}")
    if removed_codes:
        print(f"[update-crix] {len(removed_codes)} listing(s) removed upstream: {', '.join(removed_codes)}")

    if remote_payload != local_payload:
        write_json(output, remote_payload)
        print(f"[update-crix] Snapshot updated: {output}")
    else:
        print("[update-crix] No changes detected.")

    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update crix_master.json from Upbit.")
    parser.add_argument(
        "-o",
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"File path to write the snapshot (default: {DEFAULT_OUTPUT})",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    output_path = Path(args.output).expanduser().resolve()
    return sync_crix_master(output_path)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
