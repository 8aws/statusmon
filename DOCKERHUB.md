# StatusMon

**Self-hosted uptime monitor.** Track response time, TTFB, SSL expiry and server stats without depending on any external service.

No database · No registration · No telemetry · MIT license

[![GitHub](https://img.shields.io/badge/GitHub-8aws%2Fstatusmon-181717?logo=github)](https://github.com/8aws/statusmon)
[![Docker Pulls](https://img.shields.io/docker/pulls/espiralvex/statusmon)](https://hub.docker.com/r/espiralvex/statusmon)
[![Image Size](https://img.shields.io/docker/image-size/espiralvex/statusmon/latest)](https://hub.docker.com/r/espiralvex/statusmon)

---

## Quick start

```bash
docker run -d \
  --name statusmon \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/statusmon/data:/data \
  -v /proc:/host/proc:ro \
  espiralvex/statusmon:latest
```

Open **http://YOUR-IP:3000/admin** → set your password → add sites.

---

## Docker Compose

```yaml
services:
  statusmon:
    image: espiralvex/statusmon:latest
    container_name: statusmon
    restart: unless-stopped
    environment:
      - PORT=3000
      - DATA_DIR=/data
    ports:
      - "3000:3000"
    volumes:
      - /opt/statusmon/data:/data
      - /proc:/host/proc:ro
```

```bash
docker compose up -d
```

---

## ZimaOS — App Store → Custom Install

Paste this YAML in **App Store → ⊞ Custom Install**:

```yaml
services:
  statusmon:
    image: espiralvex/statusmon:latest
    container_name: statusmon
    restart: unless-stopped
    environment:
      - PORT=3000
      - DATA_DIR=/data
    ports:
      - target: 3000
        published: "${WEBUI_PORT:-3000}"
        protocol: tcp
    volumes:
      - $HOME/AppData/statusMon:/data
      - /proc:/host/proc:ro

x-casaos:
  main: statusmon
  title:
    en_us: StatusMon
  category: Network
  index: /admin
  port_map: "${WEBUI_PORT:-3000}"
```

---

## Platforms

| Platform | Support |
|---|---|
| `linux/amd64` | ✅ x86-64 (VPS, NAS, server) |
| `linux/arm64` | ✅ Raspberry Pi 4/5, Apple M-series (Rosetta) |
| `linux/arm/v7` | ✅ ZimaBlade, ZimaBoard, older Raspberry Pi |

---

## Data

All data is stored in the bind-mounted `/data` directory on the host. **Never delete this directory** — it contains your config, history, SMTP credentials and push subscriptions.

```
/data/
├── config.json       # App settings
├── sites.json        # Monitored sites
├── history.json      # Check history (up to 7 days)
├── .secret           # AES-256 key (auto-generated)
├── .jwtsecret        # JWT key (auto-generated)
├── .vapid.json       # Web Push keys (auto-generated)
└── releases/         # Applied update ZIPs
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Container port |
| `DATA_DIR` | `/data` | Data directory inside container |

All other settings (check interval, alerts, SSL, etc.) are configured from the admin panel and saved in `/data/config.json`.

---

## Features

- **HTTP/HTTPS, TCP, DNS, Heartbeat** monitors
- **Response time, TTFB, SSL expiry** tracking
- **7-day history** with time-range selector (1h/6h/24h/7d/custom)
- **P50/P75/P95/P99 stats**, uptime 24h/7d/total, MTBF, trend
- **Email alerts** (Gmail, Outlook, iCloud presets or direct SMTP)
- **Web Push** native notifications (VAPID, no third-party)
- **Server stats**: CPU, RAM, disk, load average, temperature
- **In-app updates**: upload ZIP from admin panel, no SSH needed
- **PWA** installable on mobile and desktop
- **No database** — all state in JSON files

---

## Source

[github.com/8aws/statusmon](https://github.com/8aws/statusmon) · MIT License
