# Upbit Listing Monitor

Lightweight dashboard for tracking newly listed Upbit KRW markets and visualising
their price history since listing.

The frontend is fully static: every visitor reads the same pre-generated JSON
snapshots, so the browser never calls the Upbit API directly. A small Node.js
toolchain refreshes those snapshots on the server.

- `crix_master.json` — full Upbit listing master pulled from
  `https://crix-static.upbit.com/v2/crix_master`
- `price_cache.json` — precomputed daily price series and summary stats for KRW
  markets listed within the lookback window (default 380 days)

## Features

- Filter newly listed coins by the last 1 / 3 / 6 / 12 months.
- Sortable table: coin, listing date, listing price, current price, change %.
- Inline SVG sparkline of the price trend since listing for each coin.
- No client-side API polling — the browser only fetches `price_cache.json`.
- Self-contained Node.js updaters (Node standard library only, no npm
  dependencies) plus an optional auto-updating static server.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (uses only the built-in
  `http`, `https`, `fs`, `zlib`, and `path` modules — there are no third-party
  packages to install).

## 1. Generate and refresh snapshots

Run the helper scripts once to create the initial files:

```bash
node scripts/updateCrixMaster.js
node scripts/updatePriceCache.js
```

`updatePriceCache.js` reads `crix_master.json`, so always run (or update) the
master first. Useful flags:

```bash
# crix master
node scripts/updateCrixMaster.js --output crix_master.json

# price cache
node scripts/updatePriceCache.js \
  --master crix_master.json \
  --output price_cache.json \
  --lookback-days 380 \
  --concurrency 5 \
  --count 400          # candles per coin (capped at 400)
```

Schedule them on your server so the snapshots stay fresh:

```cron
# listings every 2 hours
0 */2 * * * /usr/bin/node /var/www/upbit-listing/scripts/updateCrixMaster.js >> /var/log/upbit-listing.log 2>&1
# prices every 10 minutes
*/10 * * * * /usr/bin/node /var/www/upbit-listing/scripts/updatePriceCache.js >> /var/log/upbit-listing.log 2>&1
```

(Feel free to use `systemd` timers or another scheduler—the idea is that only the
server talks to Upbit.)

## 2. Serve the frontend

### Option A — built-in auto-updating server

```bash
node server.js --port 8009
```

What it does:

- on startup, immediately refreshes both `crix_master.json` and `price_cache.json`
- keeps refreshing them in the background (master every 2h, prices every 10m by
  default)
- serves the project directory over HTTP (default port `8000`, default bind
  `0.0.0.0`)

Common flags:

| Flag | Default | Description |
| --- | --- | --- |
| `--port` | `8000` | HTTP port |
| `--bind` | `0.0.0.0` | bind address |
| `--directory` | project root | directory to serve |
| `--master-interval` | `7200` | master refresh interval (seconds) |
| `--price-interval` | `600` | price refresh interval (seconds) |
| `--price-lookback` | `380` | listing lookback window (days) |
| `--price-concurrency` | `5` | parallel candle fetches |
| `--price-count` | `400` | candles per coin (capped at 400) |

Stop with `Ctrl+C`. For production, wrap it with a process manager (`systemd`,
`pm2`, `tmux`, …).

### Option B — any static web server

Expose the directory via Nginx/Apache/etc. Example Nginx block:

```nginx
server {
    listen 80;
    server_name your.domain;

    root /var/www/upbit-listing;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

As long as the cron jobs keep updating the JSON files, all users will see the
latest data.

## 3. Local development quickstart

```bash
# Refresh snapshots locally (requires network access to Upbit)
node scripts/updateCrixMaster.js
node scripts/updatePriceCache.js

# Serve statically with the bundled server (auto-updates in the background)
node server.js --port 8009
# Visit http://localhost:8009/

# …or serve the files with any static server, e.g.
python3 -m http.server 8000
# Visit http://localhost:8000/index.html
```

> If `price_cache.json` is missing the dashboard shows a load error. Run
> `node scripts/updatePriceCache.js` once (network access required) to generate
> it, then reload. The bundled server creates it for you on startup.

## Project layout

```
.
├── index.html                  # dashboard markup
├── assets/
│   ├── css/styles.css          # styles
│   └── js/app.js               # frontend logic (reads price_cache.json)
├── scripts/
│   ├── updateCrixMaster.js     # fetch listing master -> crix_master.json
│   └── updatePriceCache.js     # build price snapshots -> price_cache.json
├── server.js                   # static server + background updaters
├── crix_master.json            # generated listing master
└── price_cache.json            # generated price cache
```

## License

Released under the [MIT License](LICENSE).
