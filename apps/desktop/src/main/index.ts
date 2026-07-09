import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import express from "express";
import cors from "cors";
import { AppDatabase } from "./db";
import { mountMcpServer } from "./mcp/server";
import { mountLocalApi } from "./localApi";
import { mountLiveUpdates } from "./liveUpdates";
import { mountOAuthServer, requireBearerAuth } from "./oauth/server";
import { CloudflaredManager } from "./tunnel/cloudflaredManager";

const LOCAL_PORT = 4173;
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "BCBA Route Planner",
    webPreferences: {
      // No preload needed: the renderer only talks to the local backend via
      // fetch()/WebSocket over 127.0.0.1, so nodeIntegration stays off and
      // there's no need for a contextBridge API surface.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  // Open external links (e.g. "Open ChatGPT" deep links, docs) in the OS
  // default handler instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function startBackend(): AppDatabase {
  const dataDir = path.join(app.getPath("userData"), "data");
  const db = new AppDatabase(dataDir);

  const expressApp = express();
  // The renderer (loaded from a vite dev server origin, or file:// once
  // packaged) is a different origin than 127.0.0.1:4173, so it needs CORS
  // to call the local REST API. Local-only server, so a permissive policy
  // is fine -- nothing here is reachable off-device except via the tunnel,
  // which is a server-to-server call (ChatGPT), not a browser context.
  expressApp.use(cors());

  const oauthOpts = { issuer: () => db.getSetting("tunnel_hostname") ? `https://${db.getSetting("tunnel_hostname")}` : `http://127.0.0.1:${LOCAL_PORT}` };
  mountOAuthServer(expressApp, db, oauthOpts);
  // Only the tunneled ChatGPT-facing endpoint needs auth -- /api is
  // same-machine-only, used by the renderer.
  expressApp.use("/mcp", requireBearerAuth(db, oauthOpts));
  const tools = mountMcpServer(expressApp, db, "/mcp");
  mountLocalApi(expressApp, tools, "/api"); // for the renderer

  const tunnel = new CloudflaredManager();
  mountTunnelControls(expressApp, db, tunnel);
  mountBackupRoutes(expressApp, db);

  const server = http.createServer(expressApp);
  mountLiveUpdates(server, "/live");
  server.listen(LOCAL_PORT, "127.0.0.1", () => {
    console.log(`[backend] listening on http://127.0.0.1:${LOCAL_PORT}`);
  });

  return db;
}

function mountTunnelControls(expressApp: express.Express, db: AppDatabase, tunnel: CloudflaredManager) {
  expressApp.use(express.json());
  expressApp.get("/api/tunnel/status", (_req, res) => res.json(tunnel.getStatus()));
  expressApp.post("/api/tunnel/start", (req, res) => {
    const token = req.body?.token ?? db.getSetting("tunnel_token");
    if (!token) {
      res.status(400).json({ error: "no tunnel token configured" });
      return;
    }
    if (req.body?.token) db.setSetting("tunnel_token", req.body.token);
    tunnel.start(token);
    res.json(tunnel.getStatus());
  });
  expressApp.post("/api/tunnel/stop", (_req, res) => {
    tunnel.stop();
    res.json(tunnel.getStatus());
  });
}

/**
 * Cross-Mac data portability: the whole app's state is one SQLite file, so
 * "backup" is just checkpoint-then-copy. Import replaces the file and
 * relaunches the app rather than trying to hot-swap the live DB connection.
 */
function mountBackupRoutes(expressApp: express.Express, db: AppDatabase) {
  expressApp.get("/api/backup/export", (_req, res) => {
    db.checkpoint();
    const date = new Date().toISOString().slice(0, 10);
    res.download(db.filePath, `bcba-route-planner-backup-${date}.db`);
  });

  expressApp.post("/api/backup/import", express.raw({ type: "*/*", limit: "200mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "no file body received" });
      return;
    }
    const dbPath = db.filePath;
    db.close();
    fs.writeFileSync(dbPath, req.body);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    res.json({ ok: true, restarting: true });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
  });
}

let db: AppDatabase | null = null;

app.whenReady().then(() => {
  db = startBackend();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  db?.close();
});
