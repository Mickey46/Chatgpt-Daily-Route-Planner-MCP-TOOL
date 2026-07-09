import { useEffect, useState } from "react";
import KanbanView from "./views/KanbanView";
import CalendarView from "./views/CalendarView";
import ClientsView from "./views/ClientsView";
import SettingsView from "./views/SettingsView";
import { subscribeToChanges, ChangeEvent } from "./lib/api";

type Tab = "kanban" | "calendar" | "clients" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("kanban");
  const [lastEvent, setLastEvent] = useState<ChangeEvent | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    return subscribeToChanges((event) => {
      setLastEvent(event);
      setToast(describeEvent(event));
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    });
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>BCBA Route Planner</h1>
        <nav className="tabs">
          {(["kanban", "calendar", "clients", "settings"] as const).map((t) => (
            <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <button className="chat-button" onClick={() => window.open("chatgpt://")}>
          Open ChatGPT
        </button>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <main className="app-main">
        {tab === "kanban" && <KanbanView changeSignal={lastEvent} />}
        {tab === "calendar" && <CalendarView changeSignal={lastEvent} />}
        {tab === "clients" && <ClientsView changeSignal={lastEvent} />}
        {tab === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

function describeEvent(event: ChangeEvent): string {
  switch (event.kind) {
    case "session_changed":
      return "A session was updated";
    case "client_changed":
      return "A client was updated";
    case "route_recomputed":
      return `Route recomputed for ${event.date}`;
    case "note_added":
      return "A note was added";
  }
}
