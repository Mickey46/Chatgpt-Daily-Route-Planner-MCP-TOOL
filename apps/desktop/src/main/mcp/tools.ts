import { randomUUID } from "node:crypto";
import { AppDatabase, SessionType, SessionStatus } from "../db";
import { appEvents } from "../events";
import { ensureClientGeocoded, geocodeAddress, getDriveTime } from "../route/driveTimeProvider";
import { optimizeDay, OptimizerStop } from "../route/optimizer";
import * as routeHelper from "../native/routeHelper";

const DEFAULT_BUFFER_MIN = 10;

function bufferMinutes(db: AppDatabase): number {
  const raw = db.getSetting("drive_buffer_minutes");
  return raw ? Number(raw) : DEFAULT_BUFFER_MIN;
}

export class Tools {
  constructor(private db: AppDatabase) {}

  // --- clients ---

  listClients() {
    return this.db.listClients();
  }

  async createClient(input: {
    name: string;
    address: string;
    default_session_types?: SessionType[];
    notes?: string;
  }) {
    const client = this.db.createClient({ id: randomUUID(), ...input });
    // Best-effort geocode on create; don't fail client creation if it errors
    // (e.g. offline) -- it'll be retried lazily the next time a route is computed.
    try {
      await ensureClientGeocoded(this.db, client);
    } catch {
      /* geocoding retried lazily later */
    }
    appEvents.emitChange({ kind: "client_changed", clientId: client.id });
    return this.db.getClient(client.id);
  }

  async updateClient(
    id: string,
    patch: Partial<{ name: string; address: string; default_session_types: SessionType[]; notes: string }>
  ) {
    if (patch.address) {
      // Address changed -- clear cached coordinates so they're re-geocoded.
      this.db.updateClient(id, { ...patch, lat: null, lng: null });
    } else {
      this.db.updateClient(id, patch);
    }
    appEvents.emitChange({ kind: "client_changed", clientId: id });
    return this.db.getClient(id);
  }

  deleteClient(id: string) {
    this.db.deleteClient(id);
    appEvents.emitChange({ kind: "client_changed", clientId: id });
    return { ok: true };
  }

  // --- sessions ---

  listSessions(filter?: { from?: string; to?: string; status?: SessionStatus }) {
    return this.db.listSessions(filter);
  }

  createSession(input: {
    client_id: string;
    session_type: SessionType;
    date: string;
    start_time?: string;
    duration_min?: number;
    time_fixed?: boolean;
    location_override?: string;
    kanban_column?: string;
  }) {
    const session = this.db.createSession({
      id: randomUUID(),
      status: input.start_time ? "scheduled" : "unscheduled",
      kanban_column: input.kanban_column ?? (input.start_time ? input.date : "unscheduled"),
      ...input,
    });
    appEvents.emitChange({ kind: "session_changed", sessionId: session.id, date: session.date });
    return session;
  }

  updateSession(
    id: string,
    patch: Partial<{
      session_type: SessionType;
      date: string;
      start_time: string | null;
      duration_min: number;
      time_fixed: boolean;
      location_override: string | null;
      status: SessionStatus;
      kanban_column: string;
      kanban_order: number;
    }>
  ) {
    const updated = this.db.updateSession(id, patch);
    if (updated) appEvents.emitChange({ kind: "session_changed", sessionId: id, date: updated.date });
    return updated;
  }

  deleteSession(id: string) {
    const existing = this.db.getSession(id);
    this.db.deleteSession(id);
    if (existing) appEvents.emitChange({ kind: "session_changed", sessionId: id, date: existing.date });
    return { ok: true };
  }

  moveKanbanCard(id: string, column: string, order: number) {
    const updated = this.db.moveKanbanCard(id, column, order);
    if (updated) appEvents.emitChange({ kind: "session_changed", sessionId: id, date: updated.date });
    return updated;
  }

  // --- routing ---

  /** Builds OptimizerStop[] for a date, geocoding any clients that don't yet have lat/lng. */
  private async buildStopsForDate(date: string): Promise<OptimizerStop[]> {
    const sessions = this.db.listSessions({ from: date, to: date }).filter((s) => s.status !== "cancelled");
    const stops: OptimizerStop[] = [];
    for (const session of sessions) {
      let location: { lat: number; lng: number };
      if (session.location_override) {
        location = await geocodeAddress(session.location_override);
      } else {
        const client = this.db.getClient(session.client_id);
        if (!client) continue;
        location = await ensureClientGeocoded(this.db, client);
      }
      stops.push({
        session_id: session.id,
        location,
        duration_min: session.duration_min,
        time_fixed: session.time_fixed,
        start_time: session.start_time,
      });
    }
    return stops;
  }

  async computeRoute(date: string) {
    const stops = await this.buildStopsForDate(date);
    const plan = await optimizeDay(stops, getDriveTime, { bufferMinutes: bufferMinutes(this.db) });

    this.db.replaceDriveSegmentsForDate(
      date,
      plan.segments.map((s) => ({ from_session_id: s.from_session_id, to_session_id: s.to_session_id, date, minutes: s.minutes, miles: s.miles }))
    );

    appEvents.emitChange({ kind: "route_recomputed", date });
    return plan;
  }

  async suggestSchedule(date: string, unscheduledSessionIds: string[]) {
    // Temporarily treat the requested sessions as part of `date` so the
    // optimizer can place them alongside whatever's already scheduled that day.
    for (const id of unscheduledSessionIds) {
      const session = this.db.getSession(id);
      if (session && session.date !== date) {
        this.db.updateSession(id, { date });
      }
    }
    const plan = await this.computeRoute(date);
    for (const entry of plan.order) {
      this.db.updateSession(entry.session_id, {
        start_time: entry.start_time,
        status: "scheduled",
        kanban_column: date,
      });
    }
    appEvents.emitChange({ kind: "route_recomputed", date });
    return plan;
  }

  // --- calendar sync ---

  async syncToCalendar(sessionId: string) {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const client = this.db.getClient(session.client_id);
    if (!client) throw new Error(`client not found: ${session.client_id}`);
    if (!session.start_time) throw new Error("session has no start_time yet -- schedule it before syncing");

    const start = new Date(`${session.date}T${session.start_time}:00`);
    const end = new Date(start.getTime() + session.duration_min * 60_000);
    const title = `${client.name} — ${session.session_type.replace("_", " ")}`;
    const location = session.location_override ?? client.address;

    if (session.calendar_event_id) {
      await routeHelper.calendarUpdateEvent({
        eventId: session.calendar_event_id,
        title,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        location,
      });
      return { eventId: session.calendar_event_id, updated: true };
    }
    const eventId = await routeHelper.calendarCreateEvent({
      title,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      location,
    });
    this.db.updateSession(sessionId, { calendar_event_id: eventId });
    return { eventId, updated: false };
  }

  // --- notes ---

  addNote(input: { client_id?: string; session_id?: string; body: string }) {
    const note = this.db.addNote({ id: randomUUID(), ...input });
    appEvents.emitChange({ kind: "note_added", clientId: input.client_id, sessionId: input.session_id });
    return note;
  }

  listNotes(filter?: { client_id?: string; session_id?: string }) {
    return this.db.listNotes(filter);
  }

  // --- settings ---

  getSettings() {
    return {
      drive_buffer_minutes: bufferMinutes(this.db),
      tunnel_hostname: this.db.getSetting("tunnel_hostname"),
    };
  }

  setSettings(patch: { drive_buffer_minutes?: number; tunnel_hostname?: string }) {
    if (patch.drive_buffer_minutes != null) this.db.setSetting("drive_buffer_minutes", String(patch.drive_buffer_minutes));
    if (patch.tunnel_hostname != null) this.db.setSetting("tunnel_hostname", patch.tunnel_hostname);
    return this.getSettings();
  }

  async requestCalendarAccess() {
    return { granted: await routeHelper.calendarRequestAccess() };
  }
}
