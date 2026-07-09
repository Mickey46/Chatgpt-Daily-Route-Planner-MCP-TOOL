import { EventEmitter } from "node:events";

// Fired whenever an MCP tool mutates data, regardless of caller (the local
// UI or the tunneled ChatGPT connector). The WebSocket layer (see
// mcp/liveUpdates.ts) re-broadcasts these to the renderer so the kanban/
// calendar views reflect changes ChatGPT makes in near real time.

export type ChangeEvent =
  | { kind: "client_changed"; clientId: string }
  | { kind: "session_changed"; sessionId: string; date: string }
  | { kind: "route_recomputed"; date: string }
  | { kind: "note_added"; clientId?: string; sessionId?: string };

class AppEvents extends EventEmitter {
  emitChange(event: ChangeEvent) {
    this.emit("change", event);
  }
  onChange(listener: (event: ChangeEvent) => void) {
    this.on("change", listener);
    return () => this.off("change", listener);
  }
}

export const appEvents = new AppEvents();
