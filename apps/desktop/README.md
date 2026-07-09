# BCBA Route Planner

Kanban + calendar scheduling for a BCBA seeing clients at different
addresses, with drive time between sessions factored in automatically. An
Electron app for macOS, with its own local MCP server so the ChatGPT app can
read/write the same schedule.

See `/Volumes/Home/prajwal/.claude/plans/piped-sprouting-giraffe.md` for the
original architecture plan this was built from.

## What's implemented and verified

Everything below has actually been run end-to-end in this environment, not
just written:

- SQLite data layer (clients, sessions, drive segments, notes, settings, OAuth tables)
- Local MCP server (Streamable HTTP) exposing 12 tools (list/create/update/delete clients & sessions, kanban moves, route computation, calendar sync, notes)
- `RouteHelper` Swift CLI: MapKit geocoding + drive-time directions (confirmed working with real addresses, no API key needed)
- Route/schedule optimizer (fixed-time anchors + cheapest-insertion ordering + drive buffers)
- React UI: Kanban board (drag/drop), Calendar/timeline view, Clients + notes, Settings
- Local WebSocket live-update channel (UI reflects changes from any source in real time)
- Full OAuth 2.1 + PKCE + Dynamic Client Registration flow protecting `/mcp` (tested with a real register → authorize → token → authenticated MCP call round trip)
- Packaged `.dmg`/`.zip` via `electron-builder`, with `RouteHelper` bundled into `Resources/` and confirmed working from the packaged app
- Ad-hoc code signing (`build/afterPack.js`) — confirmed by simulating a real browser download (adding the `com.apple.quarantine` attribute) and launching the signed app fresh; it opens without Gatekeeper's "is damaged" error. Earlier builds used `identity: null`, which skips signing entirely and does trigger that error on modern macOS after a real download — fixed after hitting it firsthand.

## What's NOT verified (needs your accounts/hardware to test)

- **EventKit calendar sync**: the code path is implemented (`RouteHelper`'s `calendarCreateEvent`/etc.), but this environment has no GUI to click through the macOS "Allow calendar access" permission dialog, so it's never actually written an event to Calendar.app. Test this first after installing.
- **Real Cloudflare Tunnel**: `cloudflared` isn't installed in this environment. `CloudflaredManager` spawns `cloudflared tunnel run --token <token>` and expects you to have already run `cloudflared tunnel login` + created a Named Tunnel against a domain you control. See setup steps below.
- **Real ChatGPT connector registration**: the OAuth/DCR flow was tested with a synthetic client (curl), not ChatGPT's actual Developer Mode connector UI. The endpoints follow the documented spec (RFC 8414/9728/7591 + PKCE S256), but ChatGPT's real client could behave differently in edge cases.
- **Full notarization**: the app is ad-hoc signed (confirmed to avoid the "damaged" error, see above) but not notarized, since that needs a paid Apple Developer ID. AirDropping/downloading to another Mac still shows one Gatekeeper "unidentified developer" prompt the first time — that one's expected and is resolved by right-click → Open (or System Settings → Privacy & Security → "Open Anyway"), unlike the "damaged" error which had no such recovery path.

## Dev setup

```
npm install                # also rebuilds better-sqlite3 for Electron's ABI (postinstall)
npm run build:native        # builds native/RouteHelper (Swift, needs Xcode CLT)
npm run build                # builds renderer (vite) + main (tsc)
npm start                    # builds, then launches the Electron app
```

For hot-reloading the renderer during UI work, run `npx vite` (serves on
`:5173`) and open that URL directly in a browser — the renderer only talks
to the backend over `http://127.0.0.1:4173`, so it works outside Electron
too. Launch the Electron app separately (`npx electron .`) to get the same
backend running on port 4173.

## Packaging (AirDrop-ready build)

```
npm run dist    # build + build:native + electron-builder -> release/*.dmg, *.zip
```

Ad-hoc signed by default (via `build/afterPack.js`, since electron-builder's
own `identity` option doesn't understand codesign's ad-hoc `-` value — it
looks it up as a keychain identity name and fails). If you install from a
build and macOS says the app **"is damaged and can't be opened"**, that
means it was packaged with signing skipped entirely (`identity: null` and
no afterPack hook) — the fix is this ad-hoc-signing hook, not something end
users should have to work around with `xattr -cr`.

To notarize (removes even the "unidentified developer" prompt on other
Macs), you need a paid Apple Developer ID — set `identity` to your Developer
ID certificate, turn `hardenedRuntime` back on, enable `notarize`, and
provide credentials via env vars.

## ChatGPT connector setup (one-time, per Mac that runs the tunnel)

1. Install cloudflared: `brew install cloudflared`
2. `cloudflared tunnel login` (opens a browser, requires a free Cloudflare account + a domain you've added to Cloudflare)
3. `cloudflared tunnel create bcba-schedule`
4. Point a DNS record at it: `cloudflared tunnel route dns bcba-schedule schedule.yourdomain.com`
5. Get a token for it: `cloudflared tunnel token bcba-schedule`
6. In the app's Settings tab, paste that token and your hostname (`schedule.yourdomain.com`), then "Start tunnel"
7. In ChatGPT: Settings → Apps → Advanced settings → enable **Developer mode**, then Settings → Connectors → Create, pointing at `https://schedule.yourdomain.com/mcp`
8. ChatGPT will self-register (Dynamic Client Registration) and walk you through the one-click consent screen this app serves at `/oauth/authorize`

## Known scope cuts (by design, not oversights)

- No live map rendering (drive segments are shown as a list with time/distance, not pins on a map)
- No real-time sync between two Macs running simultaneously — cross-Mac data movement is via Settings → Export/Import backup (one SQLite file)
- Route optimizer is a heuristic (cheapest-insertion + forward time-walk), not a full time-window VRP solver — fine for the ~10-stops-a-day scale this is built for
