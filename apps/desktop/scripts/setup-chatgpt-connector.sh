#!/usr/bin/env bash
# One-time setup for the ChatGPT connector: creates a Cloudflare Named
# Tunnel pointed at this app's local MCP server, and prints/copies the
# final MCP URL to paste into ChatGPT.
#
# Needs: a free Cloudflare account with a domain already added to it.
# Cannot be fully automated -- `cloudflared tunnel login` opens a real
# browser login you have to complete yourself, and Cloudflare's own account
# creation isn't scriptable. Everything after that is automated here.

set -euo pipefail

APP_PORT=4173
BOLD="\033[1m"
DIM="\033[2m"
RESET="\033[0m"

step() { echo -e "\n${BOLD}==> $1${RESET}"; }

if ! command -v cloudflared >/dev/null 2>&1; then
  step "Installing cloudflared"
  if command -v brew >/dev/null 2>&1; then
    brew install cloudflared
  else
    echo "Homebrew not found. Install it from https://brew.sh, then re-run this script." >&2
    exit 1
  fi
fi

step "Log in to Cloudflare (opens your browser)"
echo "Pick the domain you want to use for the connector, e.g. yourdomain.com."
cloudflared tunnel login

read -rp "$(echo -e "${DIM}Tunnel name [bcba-schedule]: ${RESET}")" TUNNEL_NAME
TUNNEL_NAME=${TUNNEL_NAME:-bcba-schedule}

read -rp "$(echo -e "${DIM}Hostname to use, e.g. schedule.yourdomain.com: ${RESET}")" HOSTNAME
if [ -z "$HOSTNAME" ]; then
  echo "A hostname is required." >&2
  exit 1
fi

step "Creating tunnel '$TUNNEL_NAME'"
cloudflared tunnel create "$TUNNEL_NAME" || echo "(tunnel may already exist, continuing)"

step "Routing $HOSTNAME -> $TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || echo "(route may already exist, continuing)"

step "Fetching tunnel token"
TOKEN=$(cloudflared tunnel token "$TUNNEL_NAME")

MCP_URL="https://${HOSTNAME}/mcp"

if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${APP_PORT}/api/settings" | grep -q 200; then
  step "App is running -- saving hostname + starting the tunnel automatically"
  curl -s -X PATCH "http://127.0.0.1:${APP_PORT}/api/settings" \
    -H "Content-Type: application/json" \
    -d "{\"tunnel_hostname\":\"${HOSTNAME}\"}" >/dev/null
  curl -s -X POST "http://127.0.0.1:${APP_PORT}/api/tunnel/start" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"${TOKEN}\"}" >/dev/null
  echo "Tunnel starting -- check Settings in the app for status."
else
  step "App isn't running"
  echo "Open the app, go to Settings, and paste in:"
  echo "  Tunnel hostname: ${HOSTNAME}"
  echo "  Tunnel token:    ${TOKEN}"
  echo "then click 'Start tunnel'."
fi

if command -v pbcopy >/dev/null 2>&1; then
  echo -n "$MCP_URL" | pbcopy
  echo -e "\n${BOLD}MCP URL copied to clipboard:${RESET} $MCP_URL"
else
  echo -e "\n${BOLD}MCP URL:${RESET} $MCP_URL"
fi

step "Last step: add it in ChatGPT"
echo "1. ChatGPT -> Settings -> Apps -> Advanced settings -> enable Developer mode"
echo "2. Settings -> Connectors -> Create -> paste the MCP URL above"
echo "3. ChatGPT will open a one-click 'Allow access' page served by this app -- approve it"

if command -v open >/dev/null 2>&1; then
  open "https://chatgpt.com/#settings/Connectors" 2>/dev/null || true
fi
