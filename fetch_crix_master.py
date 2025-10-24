import json
import sys
from gzip import decompress
from typing import Union
from urllib.request import Request, urlopen

URL = "https://crix-static.upbit.com/v2/crix_master"


def fetch_json(url: str) -> Union[dict, list]:
    """Download JSON data from the given URL."""
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=15) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = decompress(body)
        return json.loads(body.decode("utf-8"))


def main() -> None:
    data = fetch_json(URL)
    json.dump(data, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
