# MineWatch

A small background daemon that watches a self-hosted **Minecraft Java
Edition** server and forwards four classes of events to a **WhatsApp
group**: server state (down/up), ping latency, TPS, and player
join/leave.

Uses **`@whiskeysockets/baileys`** to talk to WhatsApp Web's
multi-device WebSocket protocol directly (no headless browser, no
paid Meta API), and a combination of `minecraft-server-util`, a tiny
in-house RCON client, and a position-based tail of `logs/latest.log`
for Minecraft data.

Designed to run on the same Ubuntu Server + CasaOS host as the
Minecraft server itself.

---

## CasaOS quick start (recommended)

### 1. Prep on the host

SSH into your CasaOS box. Choose or create a folder for the project
(this folder will hold the auth volume + `.env`):

```bash
sudo mkdir -p /DATA/minewatch
sudo chown $USER:$USER /DATA/minewatch
cd /DATA/minewatch
```

Drop the following files into that folder (easiest via `scp`,
CasaOS file manager, or the CasaOS terminal app):

- `docker-compose.yml`
- `Dockerfile`
- (the project source tree as in this repo)

Or just clone the repo there and use it directly.

### 2. Configure

```bash
cp .env.example .env
nano .env       # see table below
```

Notes for a typical CasaOS install of Minecraft:

| Variable | Typical value |
|---|---|
| `MC_HOST` | `127.0.0.1` (compose uses `network_mode: host`) |
| `MC_PORT` | `25565` |
| `MC_RCON_PORT` | `25575` |
| `MC_LOG_PATH` | `/DATA/Minecraft/logs/latest.log` (CasaOS MC path) |
| `WHATSAPP_GROUP_JID` | (see "Discovering the Group JID" below) |

### 3. Discover the Group JID (one-shot)

The WhatsApp Group JID looks like `1203630xxxxxxxxx@g.us` and is **not**
the same as the invite link code. If you don't know yours yet, MineWatch
can list every group the connected account is in.

**Step 1 — auth-only startup.** Leave `WHATSAPP_GROUP_JID=` empty, set
`LIST_GROUPS_ON_START=true` in `.env`, then start the daemon. The QR
will be printed on first run (see step 4 below for scanning). After the
WhatsApp socket opens, the daemon enumerates every group you are a
member of, prints a table, and exits.

```bash
cd /DATA/minewatch
docker compose up -d --build
docker compose logs -f minewatch
# watch for the group table, then Ctrl-C (the daemon self-exits anyway)
```

Example output:

```
SUBJECT                        JID                          PARTICIPANTS
----------------------------------------------------------------------
Keluarga Besar                 1203630111122223333@g.us     12
Minecraft Server Alerts        1203630444455556666@g.us      7
Tim DevOps                     1203630777788889999@g.us      4

Total: 3 group(s)

Copy the JID of your target group into WHATSAPP_GROUP_JID in your .env,
then unset LIST_GROUPS_ON_START and restart the daemon.
```

**Step 2 — pin it down.** Copy the JID of your target group into
`WHATSAPP_GROUP_JID=` in `.env`, then set `LIST_GROUPS_ON_START=false`.
Restart the daemon normally:

```bash
docker compose up -d --build
```

**Auto-pick (optional).** If you only want the daemon to print the
JID for ONE group whose name contains a specific word (useful in CI
/ scripted deploys), set `GROUP_MATCH_KEYWORD=minecraft` (case
insensitive) instead of `LIST_GROUPS_ON_START=true`. The daemon will
find the first matching group, print `WHATSAPP_GROUP_JID=<jid>` on
stdout, and exit with code 0 (exit 2 if nothing matched).

### 4. Install via CasaOS UI (preferred)

CasaOS → **App Store** → top-right **"Custom Install"** (or "Install
Custom App" depending on version) → paste the contents of
`docker-compose.yml` → click Install. CasaOS reads the `x-casaos`
block for the icon, title, category, and exposed settings.

Or via plain Docker Compose:

```bash
cd /DATA/minewatch
docker compose up -d --build
docker compose logs -f minewatch
```

### 5. Scan the QR (first run only)

First run prints a QR code to the logs. With CasaOS it's in the
container log panel; with plain Docker it's in `docker compose logs`.
Open WhatsApp on the phone whose account will send the messages →
**Linked Devices → Link a Device** → scan the QR.

The auth credentials are persisted in `./auth_info/` (a Docker volume
on the host). Subsequent restarts reuse them — you only ever scan
once per WhatsApp account.

---

## How it talks to the Minecraft server

`docker-compose.yml` sets `network_mode: host`. This makes the
container share the host's network namespace, so `127.0.0.1` inside
the container is `127.0.0.1` on the CasaOS host. The Minecraft server
stays bound to its normal port on the host and MineWatch reaches it
exactly as if it were running natively on the box.

If you'd rather keep the container on the default bridge network
(e.g. you have multiple MC servers across containers), comment out
`network_mode: host` and set:

```yaml
    network_mode: bridge
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

…and in the `.env` set `MC_HOST=host.docker.internal`. Note: the
`host-gateway` extra_hosts trick requires Docker 20.10+ and works
reliably on Linux.

---

## Resource budget on the CasaOS host

Verified against an **Intel i5-7500 (4C/4T) + 16 GB RAM** with the MC
server capped at 8 GB:

| Component | RAM | CPU |
|---|---|---|
| Ubuntu Server + CasaOS | ~500 MB | idle |
| Minecraft Java server (8 GB heap) | 8 GB | 2-3 cores |
| MineWatch daemon (Node.js + Baileys) | ~150 MB peak | <0.1 core |
| CasaOS UI / OS headroom | ~7 GB | 1-2 cores |

MineWatch is `mem_limit: 256m / cpus: 0.5` in `docker-compose.yml` —
even a runaway loop in our code can't take the memory your MC server
needs. Container logs are capped at 10 MB × 3 files so the daemon
won't fill your disk over months of uptime.

---

## Stack

| Concern | Library | Why |
|---|---|---|
| WhatsApp Web | `@whiskeysockets/baileys` | Direct WebSocket, no headless Chromium, actively maintained |
| Server list ping + query | `minecraft-server-util` | Vanilla Java + Bedrock support, modern protocol |
| RCON (for `tps`) | custom Source-RCON client in `src/rcon.ts` | ~150 lines, no extra dep |
| Join/leave events | custom `latest.log` tail parser in `src/logTailer.ts` | Ping protocol shows only snapshot, log gives real-time |
| Logging | `pino` + `pino-pretty` | Fast, structured, low overhead |

---

## Configuration reference

All settings live in `.env`. See `.env.example` for the full list.
Quick reference:

| Var | Default | Meaning |
|---|---|---|
| `WHATSAPP_GROUP_JID` | _(required, except in list-groups mode)_ | Target group, e.g. `1203630xxxxxxxxx@g.us` |
| `LIST_GROUPS_ON_START` | `false` | One-shot mode: log every group the account is in, then exit |
| `GROUP_MATCH_KEYWORD` | _(empty)_ | One-shot mode: print JID of the first group whose subject matches this substring, then exit |
| `MC_HOST` | `127.0.0.1` | MC server hostname/IP |
| `MC_PORT` | `25565` | MC server-list-ping port |
| `MC_RCON_PORT` | `25575` | RCON port (blank to disable TPS) |
| `MC_RCON_PASSWORD` | _(empty)_ | RCON password |
| `MC_LOG_PATH` | _(empty)_ | Absolute path to `logs/latest.log` |
| `POLL_INTERVAL_MS` | `5000` | State-poll cadence |
| `LATENCY_INTERVAL_MS` | `10000` | Ping/TPS-poll cadence |
| `PING_THRESHOLD_MS` | `150` | Alert when latency > this |
| `DOWN_FAIL_COUNT` | `3` | Consecutive failures before "server down" |
| `HIGH_PING_FAIL_COUNT` | `3` | Consecutive high-ping samples before alert |
| `TPS_THRESHOLD` | `18.0` | Alert when TPS < this |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |

---

## Operations

```bash
# Rebuild after pulling new code
docker compose build --pull
docker compose up -d

# Live tail
docker compose logs -f minewatch

# Stop
docker compose down

# Full reset (wipes the WhatsApp auth - new QR required)
docker compose down -v
rm -rf ./auth_info
```

---

## Caveats

- **Ban risk.** Unofficial WhatsApp clients can get banned. Use a
  dedicated phone number if the WhatsApp account matters.
- **TPS requires Paper / Spigot / Purpur / forks.** Vanilla Java
  servers don't ship a `tps` command — MineWatch will silently skip
  TPS reporting on those. The other three monitors still work.
- **First-run QR.** Until the QR is scanned, the daemon will
  reconnect with exponential backoff. After scanning once, auth is
  persisted and runs are headless.
