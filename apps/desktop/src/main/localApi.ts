import express from "express";
import { Tools } from "./mcp/tools";

// Plain REST API for the Electron renderer (same trust domain as the main
// process, so no auth needed here -- auth only matters on the tunneled MCP
// endpoint ChatGPT talks to). Thin wrapper around the same Tools class the
// MCP server uses, so the UI and ChatGPT always see identical behavior.

export function mountLocalApi(app: express.Express, tools: Tools, mountPath = "/api") {
  const router = express.Router();
  router.use(express.json());

  router.get("/clients", (_req, res) => res.json(tools.listClients()));
  router.post("/clients", async (req, res) => res.json(await tools.createClient(req.body)));
  router.patch("/clients/:id", async (req, res) => res.json(await tools.updateClient(req.params.id, req.body)));
  router.delete("/clients/:id", (req, res) => res.json(tools.deleteClient(req.params.id)));

  router.get("/sessions", (req, res) => {
    const { from, to, status } = req.query as { from?: string; to?: string; status?: string };
    res.json(tools.listSessions({ from, to, status: status as any }));
  });
  router.post("/sessions", (req, res) => res.json(tools.createSession(req.body)));
  router.patch("/sessions/:id", (req, res) => res.json(tools.updateSession(req.params.id, req.body)));
  router.delete("/sessions/:id", (req, res) => res.json(tools.deleteSession(req.params.id)));
  router.post("/sessions/:id/move", (req, res) => res.json(tools.moveKanbanCard(req.params.id, req.body.column, req.body.order)));
  router.post("/sessions/:id/sync-calendar", async (req, res) => {
    try {
      res.json(await tools.syncToCalendar(req.params.id));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/routes/:date", async (req, res) => {
    try {
      res.json(await tools.computeRoute(req.params.date));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
  router.post("/routes/:date/suggest", async (req, res) => {
    try {
      res.json(await tools.suggestSchedule(req.params.date, req.body.session_ids ?? []));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/notes", (req, res) => {
    const { client_id, session_id } = req.query as { client_id?: string; session_id?: string };
    res.json(tools.listNotes({ client_id, session_id }));
  });
  router.post("/notes", (req, res) => res.json(tools.addNote(req.body)));

  router.get("/settings", (_req, res) => res.json(tools.getSettings()));
  router.patch("/settings", (req, res) => res.json(tools.setSettings(req.body)));
  router.post("/calendar/request-access", async (req, res) => {
    try {
      res.json(await tools.requestCalendarAccess());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.use(mountPath, router);
}
