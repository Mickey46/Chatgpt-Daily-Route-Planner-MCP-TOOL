import { useEffect, useState } from "react";
import { api, Client, Session, DayPlan, ChangeEvent } from "../lib/api";
import { toISODate } from "../lib/dates";

const SESSION_TYPE_LABEL: Record<Session["session_type"], string> = {
  direct: "Direct",
  parent_training: "Parent Training",
  supervision: "Supervision",
};

export default function CalendarView({ changeSignal }: { changeSignal: ChangeEvent | null }) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [clients, setClients] = useState<Client[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    const [c, s] = await Promise.all([api.listClients(), api.listSessions({ from: date, to: date })]);
    setClients(c);
    setSessions(s);
  }

  useEffect(() => {
    refresh();
    setPlan(null);
  }, [date]);

  useEffect(() => {
    if (changeSignal) refresh();
  }, [changeSignal]);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown client";

  async function computeRoute() {
    setLoading(true);
    try {
      setPlan(await api.computeRoute(date));
    } finally {
      setLoading(false);
    }
  }

  const orderedSessions = plan
    ? plan.order.map((entry) => sessions.find((s) => s.id === entry.session_id)).filter((s): s is Session => Boolean(s))
    : [...sessions].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));

  return (
    <div className="calendar-view">
      <div className="calendar-toolbar">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={computeRoute} disabled={loading}>
          {loading ? "Computing…" : "Compute route for this day"}
        </button>
        {plan && <span>Total drive: {plan.total_drive_minutes} min</span>}
      </div>

      {plan?.warnings.map((w, i) => (
        <div key={i} className="warning">
          ⚠ {w}
        </div>
      ))}

      <div className="timeline">
        {orderedSessions.length === 0 && <p className="empty-state">No sessions scheduled for this day yet.</p>}
        {orderedSessions.map((session, i) => {
          const planEntry = plan?.order.find((e) => e.session_id === session.id);
          const segment = i > 0 ? plan?.segments.find((s) => s.to_session_id === session.id) : undefined;
          return (
            <div key={session.id}>
              {segment && (
                <div className="drive-segment">
                  🚗 {Math.round(segment.minutes)} min · {segment.miles.toFixed(1)} mi
                </div>
              )}
              <div className="timeline-block">
                <div className="timeline-time">{planEntry?.start_time ?? session.start_time ?? "—"}</div>
                <div className="timeline-details">
                  <strong>{clientName(session.client_id)}</strong> — {SESSION_TYPE_LABEL[session.session_type]}
                  <div className="timeline-sub">
                    {session.duration_min} min{session.time_fixed && " · fixed time 🔒"}
                    {session.location_override && ` · ${session.location_override}`}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
