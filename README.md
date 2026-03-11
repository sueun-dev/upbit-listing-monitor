# Upbit Listing Monitor

Lightweight monitoring dashboard for new Upbit KRW listings and pre-generated market snapshots.

This project serves a lightweight dashboard that visualises newly listed Upbit KRW markets.  
Every visitor reads the same pre-generated JSON snapshots—there is no client-side polling of the
Upbit API.

- `crix_master.json` — list of all KRW listings pulled from `https://crix-static.upbit.com/v2/crix_master`
- `price_cache.json` — precomputed price history + summary stats for listings within the last year

## 1. Generate and refresh snapshots

Run the helper scripts once to create the initial files:

```bash
python3 scripts/update_crix_master.py
python3 scripts/update_price_cache.py
```

Schedule them on your server so the snapshots stay fresh:

```cron
# listings every 2 hours
0 */2 * * * /usr/bin/python3 /var/www/upbit-listing/scripts/update_crix_master.py >> /var/log/upbit-listing.log 2>&1
# prices every 10 minutes
*/10 * * * * /usr/bin/python3 /var/www/upbit-listing/scripts/update_price_cache.py >> /var/log/upbit-listing.log 2>&1
```

(Feel free to use `systemd` timers or another scheduler—the idea is that only the server talks to Upbit.)

## 2. Serve the frontend

### Option A — built-in auto-updating server

```bash
python3 server.py --port 8009
```

What it does:

- immediately refreshes both `crix_master.json` (2h cadence) and `price_cache.json` (10m cadence)
- keeps updating them in the background
- serves the project directory on the given port (default bind `0.0.0.0`)

Stop with `Ctrl+C`. For production, wrap it with a process manager (`systemd`, `pm2`, `tmux`, …).

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

As long as the cron jobs keep updating the JSON files, all users will see the latest data.

## 3. Local development quickstart

```bash
# Optional: refresh snapshots locally
python3 scripts/update_crix_master.py
python3 scripts/update_price_cache.py

# Serve manually
python3 -m http.server 8000

# or run the auto-updating server
python3 server.py --port 8009
# Visit http://localhost:8000/index.html (or the port you selected)
```



price_cache.json가 아직 생성되지 않아서 404가 뜬 거예요. 서버에서 한 번은 직접 캐시를 만들어 줘야 합니다.

프로젝트 폴더에서 python3 scripts/update_price_cache.py를 실행해 최신 데이터를 받아 price_cache.json을 생성하세요. (네트워크 권한 필요)
그다음 python3 server.py --port 8009처럼 서버를 켜면 10분마다 자동으로 다시 갱신합니다.
위 스크립트가 성공적으로 돌면 루트 디렉터리에 price_cache.json 파일이 생기고, 프론트엔드는 더 이상 404를 내지 않습니다.
