# 🗓️ BCBA Route Planner

A Mac app for BCBAs juggling clients across different addresses and times of
day — direct sessions, parent training, supervision. It builds your week on
a drag-and-drop kanban board, automatically works out **drive time between
sessions** so your day doesn't silently overbook itself, syncs to Apple
Calendar, and can be driven conversationally from the **ChatGPT app** via
its own MCP server.

[![Download](https://img.shields.io/badge/Download-macOS%20.dmg-blue?style=for-the-badge&logo=apple)](https://github.com/Mickey46/Chatgpt-Daily-Route-Planner-MCP-TOOL/releases/latest/download/BCBA-Route-Planner.dmg)
[![Latest Release](https://img.shields.io/github/v/release/Mickey46/Chatgpt-Daily-Route-Planner-MCP-TOOL?style=for-the-badge)](https://github.com/Mickey46/Chatgpt-Daily-Route-Planner-MCP-TOOL/releases/latest)

> Apple Silicon (M1/M2/M3/M4) Macs only. Unsigned build — see [Install](#install) for the one-time Gatekeeper step.

---

## Install

1. Click **Download** above (or grab it from [Releases](https://github.com/Mickey46/Chatgpt-Daily-Route-Planner-MCP-TOOL/releases/latest)).
2. Open the `.dmg`, drag **BCBA Route Planner** into `Applications`.
3. First launch only: right-click the app → **Open** → **Open** (this build isn't notarized with a paid Apple Developer ID, so Gatekeeper will warn once — this is expected).
4. In the app: **Settings → Request calendar access** to let it create a "BCBA Schedule" calendar in Calendar.app.

To move your schedule to another Mac: AirDrop the app once, then use **Settings → Export/Import backup** to carry your clients and sessions over.

## What it does

- **Kanban board** — one column per day + an Unscheduled backlog. Drag a session onto a day and hit **Optimize day** to auto-order it around drive time.
- **Calendar/route view** — see the day as a timeline with real drive segments (minutes + miles) inserted between stops, computed via Apple MapKit — no API key, no account needed.
- **Clients & notes** — addresses, default session types, freeform notes per client or session.
- **Apple Calendar sync** — push any scheduled session into a dedicated calendar.
- **Talk to it from ChatGPT** — "move Sarah's parent training to Thursday 2pm, does the drive to Marcus's after still work?" ChatGPT calls this app's MCP server directly. See [Connect to ChatGPT](#connect-to-chatgpt) below.

## Connect to ChatGPT

ChatGPT's connectors only work over a public HTTPS URL (it can't reach `localhost`), so this uses a free [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose the app's MCP server, protected by a real OAuth login screen.

**One-time setup** (~5 minutes, needs a free Cloudflare account + any domain you control):

```
cd apps/desktop
./scripts/setup-chatgpt-connector.sh
```

The script walks you through `cloudflared` login, creates the tunnel, and prints the exact URL to paste into ChatGPT (Settings → Apps → Advanced settings → **Developer mode** → Connectors → Create). Full manual steps and what's verified vs. not are in [apps/desktop/README.md](apps/desktop/README.md#chatgpt-connector-setup-one-time-per-mac-that-runs-the-tunnel).

## For developers

Source lives in [`apps/desktop`](apps/desktop) — Electron + React, a local MCP server (`@modelcontextprotocol/sdk`), and a small Swift CLI (`RouteHelper`) wrapping MapKit + EventKit. See [apps/desktop/README.md](apps/desktop/README.md) for dev setup, build/package commands, and what's been tested vs. what still needs verifying on real hardware/accounts.

```
cd apps/desktop
npm install
npm start        # run the app
npm run dist      # build a shippable .dmg/.zip
```
