import { useEffect, useMemo, useState } from "react";
import { api, Client, Session, ChangeEvent } from "../lib/api";
import { startOfWeek, weekDates, addDays, dayLabel } from "../lib/dates";

const SESSION_TYPE_LABEL: Record<Session["session_type"], string> = {
  direct: "Direct",
  parent_training: "Parent Training",
  supervision: "Supervision",
};

export default function KanbanView({ changeSignal }: { changeSignal: ChangeEvent | null }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [clients, setClients] = useState<Client[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [routeSummary, setRouteSummary] = useState<Record<string, { totalDrive: number; warnings: string[] }>>({});
  const [newSession, setNewSession] = useState<{ client_id: string; session_type: Session["session_type"] }>({
    client_id: "",
    session_type: "direct",
  });

  const dates = useMemo(() => weekDates(weekStart), [weekStart]);
  const columns = ["unscheduled", ...dates];

  async function refresh() {
    const [c, s] = await Promise.all([api.listClients(), api.listSessions()]);
    setClients(c);
    setSessions(s);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (changeSignal) refresh();
  }, [changeSignal]);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown client";

  const cardsFor = (column: string) =>
    sessions.filter((s) => s.kanban_column === column).sort((a, b) => a.kanban_order - b.kanban_order);

  async function handleDrop(e: React.DragEvent, column: string) {
    e.preventDefault();
    const sessionId = e.dataTransfer.getData("text/plain");
    if (!sessionId) return;
    const order = cardsFor(column).length;
    await api.moveCard(sessionId, column, order);
    if (column !== "unscheduled") {
      await api.updateSession(sessionId, { date: column });
    }
    refresh();
  }

  async function optimizeDay(date: string) {
    const ids = cardsFor(date)
      .filter((s) => !s.start_time)
      .map((s) => s.id);
    const plan = await api.suggestSchedule(date, ids);
    setRouteSummary((prev) => ({ ...prev, [date]: { totalDrive: plan.total_drive_minutes, warnings: plan.warnings } }));
    refresh();
  }

  async function addSession(column: string) {
    if (!newSession.client_id) return;
    const date = column === "unscheduled" ? dates[0] : column;
    await api.createSession({ client_id: newSession.client_id, session_type: newSession.session_type, date, kanban_column: column });
    refresh();
  }

  return (
    <div className="kanban">
      <div className="kanban-toolbar">
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>&larr; Prev week</button>
        <span>
          Week of {dates[0]} – {dates[6]}
        </span>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>Next week &rarr;</button>
      </div>

      <div className="kanban-board">
        {columns.map((column, i) => (
          <div key={column} className="kanban-column" onDragOver={(e) => e.preventDefault()} onDrop={(e) => handleDrop(e, column)}>
            <div className="kanban-column-header">
              <span>{column === "unscheduled" ? "Unscheduled" : dayLabel(i - 1, column)}</span>
              {column !== "unscheduled" && (
                <button className="small-button" onClick={() => optimizeDay(column)}>
                  Optimize day
                </button>
              )}
            </div>

            {column !== "unscheduled" && routeSummary[column] && (
              <div className="route-summary">
                Total drive: {routeSummary[column].totalDrive} min
                {routeSummary[column].warnings.map((w, idx) => (
                  <div key={idx} className="warning">
                    ⚠ {w}
                  </div>
                ))}
              </div>
            )}

            {cardsFor(column).map((session) => (
              <div key={session.id} className="session-card" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", session.id)}>
                <div className="session-card-title">{clientName(session.client_id)}</div>
                <div className="session-card-meta">{SESSION_TYPE_LABEL[session.session_type]}</div>
                {session.start_time && (
                  <div className="session-card-time">
                    {session.start_time} · {session.duration_min}min {session.time_fixed && "🔒"}
                  </div>
                )}
                {!session.calendar_event_id && session.start_time && (
                  <button className="small-button" onClick={() => api.syncToCalendar(session.id).then(refresh)}>
                    Sync to Calendar
                  </button>
                )}
              </div>
            ))}

            <div className="kanban-add">
              <select value={newSession.client_id} onChange={(e) => setNewSession((s) => ({ ...s, client_id: e.target.value }))}>
                <option value="">+ Add session…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {newSession.client_id && (
                <>
                  <select
                    value={newSession.session_type}
                    onChange={(e) => setNewSession((s) => ({ ...s, session_type: e.target.value as Session["session_type"] }))}
                  >
                    <option value="direct">Direct</option>
                    <option value="parent_training">Parent Training</option>
                    <option value="supervision">Supervision</option>
                  </select>
                  <button className="small-button" onClick={() => addSession(column)}>
                    Add
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
