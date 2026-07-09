import type { Server as HTTPServer } from "node:http";
import { WebSocketServer } from "ws";
import { appEvents } from "./events";

// Broadcasts appEvents changes to the renderer over a local WebSocket, so
// edits made via the ChatGPT connector (or anything else hitting the MCP/API
// endpoints) show up in the UI without polling.

export function mountLiveUpdates(server: HTTPServer, path = "/live") {
  const wss = new WebSocketServer({ server, path });

  const unsubscribe = appEvents.onChange((event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  });

  wss.on("close", unsubscribe);
  return wss;
}
