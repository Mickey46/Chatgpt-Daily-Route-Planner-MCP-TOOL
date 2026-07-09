import { useEffect, useState } from "react";
import { api, Client, ChangeEvent, SessionType } from "../lib/api";

const ALL_TYPES: SessionType[] = ["direct", "parent_training", "supervision"];

export default function ClientsView({ changeSignal }: { changeSignal: ChangeEvent | null }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ id: string; body: string; created_at: string }[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [form, setForm] = useState({ name: "", address: "", default_session_types: [] as SessionType[] });

  async function refresh() {
    setClients(await api.listClients());
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (changeSignal) refresh();
  }, [changeSignal]);

  useEffect(() => {
    if (selected) api.listNotes({ client_id: selected }).then(setNotes);
    else setNotes([]);
  }, [selected, changeSignal]);

  async function createClient() {
    if (!form.name || !form.address) return;
    await api.createClient(form);
    setForm({ name: "", address: "", default_session_types: [] });
    refresh();
  }

  async function saveNote() {
    if (!selected || !noteDraft.trim()) return;
    await api.addNote({ client_id: selected, body: noteDraft.trim() });
    setNoteDraft("");
  }

  const selectedClient = clients.find((c) => c.id === selected) ?? null;

  return (
    <div className="clients-view">
      <div className="clients-list">
        <div className="client-form">
          <input placeholder="Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input placeholder="Address" value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
          <div className="type-checkboxes">
            {ALL_TYPES.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={form.default_session_types.includes(t)}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      default_session_types: e.target.checked
                        ? [...f.default_session_types, t]
                        : f.default_session_types.filter((x) => x !== t),
                    }))
                  }
                />
                {t}
              </label>
            ))}
          </div>
          <button onClick={createClient}>Add client</button>
        </div>

        {clients.map((c) => (
          <div key={c.id} className={c.id === selected ? "client-row selected" : "client-row"} onClick={() => setSelected(c.id)}>
            <strong>{c.name}</strong>
            <div className="client-address">{c.address}</div>
            {c.lat == null && <div className="warning">not geocoded yet</div>}
          </div>
        ))}
      </div>

      <div className="client-detail">
        {!selectedClient && <p className="empty-state">Select a client to view notes.</p>}
        {selectedClient && (
          <>
            <h2>{selectedClient.name}</h2>
            <p>{selectedClient.address}</p>
            <p>{selectedClient.default_session_types.join(", ") || "No default session types set"}</p>

            <h3>Notes</h3>
            <div className="note-form">
              <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Add a note…" />
              <button onClick={saveNote}>Save note</button>
            </div>
            {notes.map((n) => (
              <div key={n.id} className="note">
                <div className="note-date">{new Date(n.created_at).toLocaleString()}</div>
                <div>{n.body}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
