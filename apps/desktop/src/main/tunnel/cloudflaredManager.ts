import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

// Manages a `cloudflared` child process that exposes the local backend at a
// stable hostname, so ChatGPT's MCP connector (which requires a public
// HTTPS endpoint -- see src/main/oauth/server.ts) can reach it.
//
// Requires the user to have already run `cloudflared tunnel login` and
// created a Named Tunnel bound to a hostname they control (free Cloudflare
// account + a domain). This manager just runs `cloudflared tunnel run
// --token <token>`, which needs no further config once that token exists.
// See README "ChatGPT connector setup" for the one-time steps.
//
// UNVERIFIED: not yet run against a real Cloudflare account/tunnel in this
// environment (cloudflared isn't installed here). Treat as a Phase 0 spike
// to validate before relying on it.

export type TunnelStatus = "stopped" | "starting" | "running" | "error";

export class CloudflaredManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: TunnelStatus = "stopped";
  private lastError: string | null = null;
  private onStatusChange: (status: TunnelStatus) => void;

  constructor(onStatusChange: (status: TunnelStatus) => void = () => {}) {
    this.onStatusChange = onStatusChange;
  }

  getStatus() {
    return { status: this.status, lastError: this.lastError };
  }

  start(tunnelToken: string) {
    if (this.proc) return;
    this.setStatus("starting");
    this.proc = spawn("cloudflared", ["tunnel", "run", "--token", tunnelToken], { stdio: "pipe" });

    this.proc.stdout.on("data", (d) => this.inspectLog(d.toString()));
    this.proc.stderr.on("data", (d) => this.inspectLog(d.toString()));

    this.proc.on("error", (err) => {
      this.lastError = `cloudflared not found or failed to start: ${err.message}. Install with 'brew install cloudflared'.`;
      this.setStatus("error");
      this.proc = null;
    });

    this.proc.on("exit", (code) => {
      if (this.status !== "error") {
        this.lastError = code === 0 ? null : `cloudflared exited with code ${code}`;
        this.setStatus(code === 0 ? "stopped" : "error");
      }
      this.proc = null;
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.setStatus("stopped");
  }

  private inspectLog(line: string) {
    // cloudflared logs a "Registered tunnel connection" line once the
    // tunnel is actually up; treat that as our readiness signal.
    if (/Registered tunnel connection/i.test(line)) {
      this.setStatus("running");
    }
  }

  private setStatus(status: TunnelStatus) {
    this.status = status;
    this.onStatusChange(status);
  }
}
