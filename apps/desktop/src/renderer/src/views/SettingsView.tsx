import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "../lib/api";

export default function SettingsView() {
  const [bufferMin, setBufferMin] = useState(10);
  const [tunnelHostname, setTunnelHostname] = useState("");
  const [calendarStatus, setCalendarStatus] = useState<"unknown" | "granted" | "denied">("unknown");
  const [saving, setSaving] = useState(false);
  const [tunnelToken, setTunnelToken] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState<{ status: string; lastError: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getSettings().then((s) => {
      setBufferMin(s.drive_buffer_minutes);
      setTunnelHostname(s.tunnel_hostname ?? "");
    });
    api.getTunnelStatus().then(setTunnelStatus);
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.updateSettings({ drive_buffer_minutes: bufferMin, tunnel_hostname: tunnelHostname });
    } finally {
      setSaving(false);
    }
  }

  async function requestCalendar() {
    const { granted } = await api.requestCalendarAccess();
    setCalendarStatus(granted ? "granted" : "denied");
  }

  return (
    <div className="settings-view">
      <section>
        <h2>Scheduling</h2>
        <label>
          Minimum drive buffer between sessions (minutes)
          <input type="number" min={0} value={bufferMin} onChange={(e) => setBufferMin(Number(e.target.value))} />
        </label>
      </section>

      <section>
        <h2>Apple Calendar</h2>
        <p>Sessions sync into a dedicated "BCBA Schedule" calendar in Calendar.app.</p>
        <button onClick={requestCalendar}>Request calendar access</button>
        {calendarStatus !== "unknown" && <p>Status: {calendarStatus}</p>}
      </section>

      <section>
        <h2>ChatGPT connector</h2>
        <p>
          To talk to this schedule from the ChatGPT app: enable <em>Developer Mode</em> under ChatGPT Settings →
          Apps → Advanced settings, then add a custom connector pointing at this app's tunneled MCP endpoint
          (<code>https://&lt;your-tunnel-hostname&gt;/mcp</code>). See the project README for the one-time
          Cloudflare Tunnel setup this requires.
        </p>
        <label>
          Tunnel hostname
          <input
            placeholder="e.g. schedule.yourdomain.com"
            value={tunnelHostname}
            onChange={(e) => setTunnelHostname(e.target.value)}
          />
        </label>
        <label>
          Cloudflare Tunnel token
          <input
            type="password"
            placeholder="from `cloudflared tunnel token <name>`"
            value={tunnelToken}
            onChange={(e) => setTunnelToken(e.target.value)}
          />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => api.startTunnel(tunnelToken || undefined).then(setTunnelStatus)}>Start tunnel</button>
          <button onClick={() => api.stopTunnel().then(setTunnelStatus)}>Stop tunnel</button>
        </div>
        {tunnelStatus && (
          <p>
            Status: {tunnelStatus.status}
            {tunnelStatus.lastError && ` — ${tunnelStatus.lastError}`}
          </p>
        )}

        {tunnelHostname && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(`https://${tunnelHostname}/mcp`);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied!" : "Copy MCP URL"}
            </button>
            <button onClick={() => window.open("https://chatgpt.com/#settings/Connectors")}>Open ChatGPT connectors</button>
          </div>
        )}

        <p className="hint">
          First time? Run <code>./scripts/setup-chatgpt-connector.sh</code> from the <code>apps/desktop</code> folder
          — it handles the Cloudflare Tunnel setup and fills these in for you. Requires `cloudflared` (brew install
          cloudflared) and a Named Tunnel against a domain you control. This flow is unverified against a live
          Cloudflare account/ChatGPT connector; treat it as a starting point to test, not a guarantee.
        </p>
      </section>

      <section>
        <h2>Backup / move to another Mac</h2>
        <p>
          All your data (clients, sessions, notes) lives in one file. AirDrop the app once, then use these to carry
          your schedule over.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.open("http://127.0.0.1:4173/api/backup/export")}>Export backup</button>
          <label className="small-button" style={{ display: "inline-flex", alignItems: "center" }}>
            Import backup…
            <input type="file" accept=".db" style={{ display: "none" }} onChange={importBackup} />
          </label>
        </div>
        <p className="hint">Importing replaces all current data and restarts the app.</p>
      </section>

      <button onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );

  async function importBackup(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm("This replaces all current data with the imported backup and restarts the app. Continue?")) return;
    const bytes = await file.arrayBuffer();
    await fetch("http://127.0.0.1:4173/api/backup/import", { method: "POST", body: bytes });
  }
}
