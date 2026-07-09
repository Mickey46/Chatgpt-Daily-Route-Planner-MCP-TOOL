const BASE = "http://127.0.0.1:4173/api";
const WS_URL = "ws://127.0.0.1:4173/live";

export type SessionType = "direct" | "parent_training" | "supervision";
export type SessionStatus = "unscheduled" | "scheduled" | "completed" | "cancelled";

export interface Client {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  default_session_types: SessionType[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  client_id: string;
  session_type: SessionType;
  date: string;
  start_time: string | null;
  duration_min: number;
  time_fixed: boolean;
  location_override: string | null;
  status: SessionStatus;
  kanban_column: string;
  kanban_order: number;
  calendar_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriveSegment {
  from_session_id: string;
  to_session_id: string;
  minutes: number;
  miles: number;
}

export interface DayPlan {
  order: { session_id: string; start_time: string; end_time: string; time_fixed: boolean }[];
  segments: DriveSegment[];
  total_drive_minutes: number;
  warnings: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listClients: () => request<Client[]>("/clients"),
  createClient: (input: Partial<Client> & { name: string; address: string }) =>
    request<Client>("/clients", { method: "POST", body: JSON.stringify(input) }),
  updateClient: (id: string, patch: Partial<Client>) =>
    request<Client>(`/clients/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteClient: (id: string) => request<{ ok: true }>(`/clients/${id}`, { method: "DELETE" }),

  listSessions: (params?: { from?: string; to?: string; status?: SessionStatus }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<Session[]>(`/sessions${qs ? `?${qs}` : ""}`);
  },
  createSession: (input: Partial<Session> & { client_id: string; session_type: SessionType; date: string }) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify(input) }),
  updateSession: (id: string, patch: Partial<Session>) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (id: string) => request<{ ok: true }>(`/sessions/${id}`, { method: "DELETE" }),
  moveCard: (id: string, column: string, order: number) =>
    request<Session>(`/sessions/${id}/move`, { method: "POST", body: JSON.stringify({ column, order }) }),
  syncToCalendar: (id: string) => request<{ eventId: string }>(`/sessions/${id}/sync-calendar`, { method: "POST" }),

  computeRoute: (date: string) => request<DayPlan>(`/routes/${date}`),
  suggestSchedule: (date: string, sessionIds: string[]) =>
    request<DayPlan>(`/routes/${date}/suggest`, { method: "POST", body: JSON.stringify({ session_ids: sessionIds }) }),

  listNotes: (params?: { client_id?: string; session_id?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ id: string; body: string; created_at: string }[]>(`/notes${qs ? `?${qs}` : ""}`);
  },
  addNote: (input: { client_id?: string; session_id?: string; body: string }) =>
    request<{ id: string }>("/notes", { method: "POST", body: JSON.stringify(input) }),

  getSettings: () => request<{ drive_buffer_minutes: number; tunnel_hostname: string | null }>("/settings"),
  updateSettings: (patch: { drive_buffer_minutes?: number; tunnel_hostname?: string }) =>
    request<{ drive_buffer_minutes: number; tunnel_hostname: string | null }>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  requestCalendarAccess: () => request<{ granted: boolean }>("/calendar/request-access", { method: "POST" }),

  getTunnelStatus: () => request<{ status: string; lastError: string | null }>("/tunnel/status"),
  startTunnel: (token?: string) => request<{ status: string; lastError: string | null }>("/tunnel/start", { method: "POST", body: JSON.stringify({ token }) }),
  stopTunnel: () => request<{ status: string; lastError: string | null }>("/tunnel/stop", { method: "POST" }),
};

export type ChangeEvent =
  | { kind: "client_changed"; clientId: string }
  | { kind: "session_changed"; sessionId: string; date: string }
  | { kind: "route_recomputed"; date: string }
  | { kind: "note_added"; clientId?: string; sessionId?: string };

/** Subscribes to the live-update WebSocket; returns an unsubscribe function. Auto-reconnects on drop. */
export function subscribeToChanges(onChange: (event: ChangeEvent) => void): () => void {
  let closed = false;
  let ws: WebSocket | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(WS_URL);
    ws.onmessage = (msg) => {
      try {
        onChange(JSON.parse(msg.data));
      } catch {
        /* ignore malformed message */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 2000);
    };
  };
  connect();

  return () => {
    closed = true;
    ws?.close();
  };
}
