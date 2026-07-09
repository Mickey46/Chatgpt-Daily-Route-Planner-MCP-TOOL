import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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
  date: string; // YYYY-MM-DD
  start_time: string | null; // HH:MM, 24h
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
  id: string;
  from_session_id: string;
  to_session_id: string;
  date: string;
  minutes: number;
  miles: number;
  computed_at: string;
}

export interface Note {
  id: string;
  client_id: string | null;
  session_id: string | null;
  body: string;
  created_at: string;
}

type ClientRow = Omit<Client, "default_session_types"> & { default_session_types: string };
type SessionRow = Omit<Session, "time_fixed"> & { time_fixed: number };

function rowToClient(row: ClientRow): Client {
  return { ...row, default_session_types: JSON.parse(row.default_session_types) };
}

function rowToSession(row: SessionRow): Session {
  return { ...row, time_fixed: row.time_fixed === 1 };
}

export class AppDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "data.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
    this.db.exec(schema);
  }

  close() {
    this.db.close();
  }

  get raw() {
    return this.db;
  }

  /** Merges the WAL into the main file so it's a single self-contained file to back up. */
  checkpoint() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  get filePath(): string {
    return this.db.name;
  }

  // --- clients ---

  listClients(): Client[] {
    const rows = this.db.prepare("SELECT * FROM clients ORDER BY name ASC").all() as ClientRow[];
    return rows.map(rowToClient);
  }

  getClient(id: string): Client | null {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined;
    return row ? rowToClient(row) : null;
  }

  createClient(input: {
    id: string;
    name: string;
    address: string;
    lat?: number | null;
    lng?: number | null;
    default_session_types?: SessionType[];
    notes?: string | null;
  }): Client {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO clients (id, name, address, lat, lng, default_session_types, notes, created_at, updated_at)
         VALUES (@id, @name, @address, @lat, @lng, @default_session_types, @notes, @now, @now)`
      )
      .run({
        id: input.id,
        name: input.name,
        address: input.address,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        default_session_types: JSON.stringify(input.default_session_types ?? []),
        notes: input.notes ?? null,
        now,
      });
    return this.getClient(input.id)!;
  }

  updateClient(
    id: string,
    patch: Partial<Pick<Client, "name" | "address" | "lat" | "lng" | "default_session_types" | "notes">>
  ): Client | null {
    const existing = this.getClient(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE clients SET name=@name, address=@address, lat=@lat, lng=@lng,
         default_session_types=@default_session_types, notes=@notes, updated_at=@updated_at
         WHERE id=@id`
      )
      .run({
        id,
        name: merged.name,
        address: merged.address,
        lat: merged.lat,
        lng: merged.lng,
        default_session_types: JSON.stringify(merged.default_session_types),
        notes: merged.notes,
        updated_at: new Date().toISOString(),
      });
    return this.getClient(id);
  }

  deleteClient(id: string): void {
    this.db.prepare("DELETE FROM clients WHERE id = ?").run(id);
  }

  // --- sessions ---

  listSessions(filter?: { from?: string; to?: string; status?: SessionStatus }): Session[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter?.from) {
      clauses.push("date >= @from");
      params.from = filter.from;
    }
    if (filter?.to) {
      clauses.push("date <= @to");
      params.to = filter.to;
    }
    if (filter?.status) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY date ASC, kanban_order ASC, start_time ASC`)
      .all(params) as SessionRow[];
    return rows.map(rowToSession);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  createSession(input: {
    id: string;
    client_id: string;
    session_type: SessionType;
    date: string;
    start_time?: string | null;
    duration_min?: number;
    time_fixed?: boolean;
    location_override?: string | null;
    status?: SessionStatus;
    kanban_column?: string;
    kanban_order?: number;
  }): Session {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, client_id, session_type, date, start_time, duration_min, time_fixed, location_override,
          status, kanban_column, kanban_order, calendar_event_id, created_at, updated_at)
         VALUES (@id, @client_id, @session_type, @date, @start_time, @duration_min, @time_fixed, @location_override,
          @status, @kanban_column, @kanban_order, NULL, @now, @now)`
      )
      .run({
        id: input.id,
        client_id: input.client_id,
        session_type: input.session_type,
        date: input.date,
        start_time: input.start_time ?? null,
        duration_min: input.duration_min ?? 60,
        time_fixed: input.time_fixed ? 1 : 0,
        location_override: input.location_override ?? null,
        status: input.status ?? "unscheduled",
        kanban_column: input.kanban_column ?? "unscheduled",
        kanban_order: input.kanban_order ?? 0,
        now,
      });
    return this.getSession(input.id)!;
  }

  updateSession(
    id: string,
    patch: Partial<
      Pick<
        Session,
        | "session_type"
        | "date"
        | "start_time"
        | "duration_min"
        | "time_fixed"
        | "location_override"
        | "status"
        | "kanban_column"
        | "kanban_order"
        | "calendar_event_id"
      >
    >
  ): Session | null {
    const existing = this.getSession(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE sessions SET session_type=@session_type, date=@date, start_time=@start_time,
         duration_min=@duration_min, time_fixed=@time_fixed, location_override=@location_override,
         status=@status, kanban_column=@kanban_column, kanban_order=@kanban_order,
         calendar_event_id=@calendar_event_id, updated_at=@updated_at
         WHERE id=@id`
      )
      .run({
        id,
        session_type: merged.session_type,
        date: merged.date,
        start_time: merged.start_time,
        duration_min: merged.duration_min,
        time_fixed: merged.time_fixed ? 1 : 0,
        location_override: merged.location_override,
        status: merged.status,
        kanban_column: merged.kanban_column,
        kanban_order: merged.kanban_order,
        calendar_event_id: merged.calendar_event_id,
        updated_at: new Date().toISOString(),
      });
    return this.getSession(id);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  moveKanbanCard(id: string, column: string, order: number): Session | null {
    return this.updateSession(id, { kanban_column: column, kanban_order: order });
  }

  // --- drive segments ---

  replaceDriveSegmentsForDate(date: string, segments: Omit<DriveSegment, "id" | "computed_at">[]): DriveSegment[] {
    const now = new Date().toISOString();
    const del = this.db.prepare("DELETE FROM drive_segments WHERE date = ?");
    const insert = this.db.prepare(
      `INSERT INTO drive_segments (id, from_session_id, to_session_id, date, minutes, miles, computed_at)
       VALUES (@id, @from_session_id, @to_session_id, @date, @minutes, @miles, @computed_at)`
    );
    const tx = this.db.transaction((segs: Omit<DriveSegment, "id" | "computed_at">[]) => {
      del.run(date);
      for (const seg of segs) {
        insert.run({ id: cryptoRandomId(), ...seg, computed_at: now });
      }
    });
    tx(segments);
    return this.listDriveSegmentsForDate(date);
  }

  listDriveSegmentsForDate(date: string): DriveSegment[] {
    return this.db.prepare("SELECT * FROM drive_segments WHERE date = ? ORDER BY computed_at ASC").all(date) as DriveSegment[];
  }

  // --- notes ---

  addNote(input: { id: string; client_id?: string | null; session_id?: string | null; body: string }): Note {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO notes (id, client_id, session_id, body, created_at) VALUES (@id, @client_id, @session_id, @body, @now)`
      )
      .run({ id: input.id, client_id: input.client_id ?? null, session_id: input.session_id ?? null, body: input.body, now });
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(input.id) as Note;
  }

  listNotes(filter?: { client_id?: string; session_id?: string }): Note[] {
    if (filter?.client_id) {
      return this.db.prepare("SELECT * FROM notes WHERE client_id = ? ORDER BY created_at DESC").all(filter.client_id) as Note[];
    }
    if (filter?.session_id) {
      return this.db.prepare("SELECT * FROM notes WHERE session_id = ? ORDER BY created_at DESC").all(filter.session_id) as Note[];
    }
    return this.db.prepare("SELECT * FROM notes ORDER BY created_at DESC").all() as Note[];
  }

  // --- settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // --- oauth ---

  createOAuthClient(input: { client_id: string; client_name?: string; redirect_uris: string[] }): void {
    this.db
      .prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .run(input.client_id, input.client_name ?? null, JSON.stringify(input.redirect_uris), new Date().toISOString());
  }

  getOAuthClient(clientId: string): { client_id: string; client_name: string | null; redirect_uris: string[] } | null {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | { client_id: string; client_name: string | null; redirect_uris: string }
      | undefined;
    return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) } : null;
  }

  createOAuthCode(input: {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    expires_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at, used)
         VALUES (@code, @client_id, @redirect_uri, @code_challenge, @code_challenge_method, @expires_at, 0)`
      )
      .run(input);
  }

  consumeOAuthCode(code: string): {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    expires_at: string;
    used: number;
  } | null {
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(code) as any;
    if (!row) return null;
    this.db.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ?").run(code);
    return row;
  }

  createOAuthToken(input: { access_token: string; refresh_token: string; client_id: string; expires_at: string }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (access_token, refresh_token, client_id, expires_at, created_at)
         VALUES (@access_token, @refresh_token, @client_id, @expires_at, @now)`
      )
      .run({ ...input, now: new Date().toISOString() });
  }

  getOAuthTokenByAccessToken(token: string): { access_token: string; client_id: string; expires_at: string } | null {
    return (this.db.prepare("SELECT * FROM oauth_tokens WHERE access_token = ?").get(token) as any) ?? null;
  }

  getOAuthTokenByRefreshToken(token: string): { access_token: string; refresh_token: string; client_id: string } | null {
    return (this.db.prepare("SELECT * FROM oauth_tokens WHERE refresh_token = ?").get(token) as any) ?? null;
  }

  deleteOAuthToken(accessToken: string): void {
    this.db.prepare("DELETE FROM oauth_tokens WHERE access_token = ?").run(accessToken);
  }
}

function cryptoRandomId(): string {
  return require("node:crypto").randomUUID();
}
