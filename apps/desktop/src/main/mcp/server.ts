import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AppDatabase } from "../db";
import { Tools } from "./tools";

const sessionTypeSchema = z.enum(["direct", "parent_training", "supervision"]);
const sessionStatusSchema = z.enum(["unscheduled", "scheduled", "completed", "cancelled"]);

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function buildMcpServer(tools: Tools): McpServer {
  const server = new McpServer({ name: "bcba-route-planner", version: "0.1.0" });

  server.tool("list_clients", "List all clients with their addresses and default session types.", {}, async () =>
    textResult(tools.listClients())
  );

  server.tool(
    "create_client",
    "Create a new client with a name and address.",
    {
      name: z.string(),
      address: z.string(),
      default_session_types: z.array(sessionTypeSchema).optional(),
      notes: z.string().optional(),
    },
    async (input) => textResult(await tools.createClient(input))
  );

  server.tool(
    "update_client",
    "Update an existing client's name, address, default session types, or notes.",
    {
      id: z.string(),
      name: z.string().optional(),
      address: z.string().optional(),
      default_session_types: z.array(sessionTypeSchema).optional(),
      notes: z.string().optional(),
    },
    async ({ id, ...patch }) => textResult(await tools.updateClient(id, patch))
  );

  server.tool(
    "list_sessions",
    "List sessions, optionally filtered by date range (YYYY-MM-DD) and/or status.",
    { from: z.string().optional(), to: z.string().optional(), status: sessionStatusSchema.optional() },
    async (filter) => textResult(tools.listSessions(filter))
  );

  server.tool(
    "create_session",
    "Create a new session (a client visit) on a given date. If start_time is omitted the session goes into the Unscheduled kanban column.",
    {
      client_id: z.string(),
      session_type: sessionTypeSchema,
      date: z.string().describe("YYYY-MM-DD"),
      start_time: z.string().optional().describe("HH:MM 24h"),
      duration_min: z.number().optional(),
      time_fixed: z.boolean().optional().describe("true if this time cannot move (e.g. only time the family is home)"),
      location_override: z.string().optional().describe("use if this session isn't at the client's default address"),
    },
    async (input) => textResult(tools.createSession(input))
  );

  server.tool(
    "update_session",
    "Update a session's time, date, type, status, or location.",
    {
      id: z.string(),
      session_type: sessionTypeSchema.optional(),
      date: z.string().optional(),
      start_time: z.string().nullable().optional(),
      duration_min: z.number().optional(),
      time_fixed: z.boolean().optional(),
      location_override: z.string().nullable().optional(),
      status: sessionStatusSchema.optional(),
    },
    async ({ id, ...patch }) => textResult(tools.updateSession(id, patch))
  );

  server.tool("delete_session", "Delete a session.", { id: z.string() }, async ({ id }) => textResult(tools.deleteSession(id)));

  server.tool(
    "move_kanban_card",
    "Move a session to a different kanban column/position (e.g. moving it to a different day, or into 'unscheduled').",
    { id: z.string(), column: z.string(), order: z.number() },
    async ({ id, column, order }) => textResult(tools.moveKanbanCard(id, column, order))
  );

  server.tool(
    "compute_route",
    "Compute the optimized drive order and drive-time segments for all of a given date's sessions.",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) => textResult(await tools.computeRoute(date))
  );

  server.tool(
    "suggest_schedule",
    "Given a date and a list of currently-unscheduled session ids, propose times for them (minimizing drive time around any fixed-time sessions already on that date) and apply the result.",
    { date: z.string().describe("YYYY-MM-DD"), session_ids: z.array(z.string()) },
    async ({ date, session_ids }) => textResult(await tools.suggestSchedule(date, session_ids))
  );

  server.tool(
    "sync_to_calendar",
    "Push a scheduled session to the user's Apple Calendar (creates or updates the event).",
    { session_id: z.string() },
    async ({ session_id }) => textResult(await tools.syncToCalendar(session_id))
  );

  server.tool(
    "add_note",
    "Add a note attached to a client and/or a specific session.",
    { client_id: z.string().optional(), session_id: z.string().optional(), body: z.string() },
    async (input) => textResult(tools.addNote(input))
  );

  server.tool(
    "list_notes",
    "List notes, optionally filtered by client or session.",
    { client_id: z.string().optional(), session_id: z.string().optional() },
    async (filter) => textResult(tools.listNotes(filter))
  );

  return server;
}

/**
 * Mounts the MCP Streamable HTTP endpoint at POST/GET/DELETE {mountPath}.
 * Each HTTP session gets its own McpServer + transport pair, per the
 * StreamableHTTPServerTransport session model.
 */
export function mountMcpServer(app: express.Express, db: AppDatabase, mountPath = "/mcp") {
  const tools = new Tools(db);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(mountPath, express.json(), async (req, res) => {
    const sessionIdHeader = req.header("mcp-session-id");
    let transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server = buildMcpServer(tools);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionIdHeader = req.header("mcp-session-id");
    const transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;
    if (!transport) {
      res.status(400).send("Unknown or missing mcp-session-id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get(mountPath, handleSessionRequest);
  app.delete(mountPath, handleSessionRequest);

  return tools;
}
