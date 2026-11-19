import { useEffect, useState } from "react";
import {
  AGENT_MEMORY_INDEX_BYTES,
  AGENT_MEMORY_NOTE_BYTES,
  AGENT_MEMORY_NOTE_ID_PATTERN,
  type AgentMemoryArgs,
  type AgentMemoryResult,
} from "@pwragent/shared";

type MemoryDocument = Extract<AgentMemoryResult, { revision: string }>;

export function AgentMemoryPanel({ access, canEdit }: {
  access: (operation: AgentMemoryArgs) => Promise<AgentMemoryResult>;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button className="context-list__action" type="button" aria-expanded={open}
        onClick={() => { setOpened(true); setOpen(!open); }}>
        {open ? "Close memory" : "Memory"}
      </button>
      {opened ? <div hidden={!open}><MemoryEditor access={access} canEdit={canEdit} /></div> : null}
    </>
  );
}

function MemoryEditor({ access, canEdit }: {
  access: (operation: AgentMemoryArgs) => Promise<AgentMemoryResult>;
  canEdit: boolean;
}) {
  const [notes, setNotes] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [newNote, setNewNote] = useState<string>();
  const [file, setFile] = useState<MemoryDocument>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = file !== undefined && draft !== file.content;
  const size = new TextEncoder().encode(draft).byteLength;
  const limit = selected ? AGENT_MEMORY_NOTE_BYTES : AGENT_MEMORY_INDEX_BYTES;

  useEffect(() => {
    let dispose = false;
    void Promise.all([access({ action: "list" }), access({ action: "read_index" })]).then(([list, index]) => {
      if (dispose) return;
      if ("noteIds" in list) setNotes(list.noteIds);
      if ("content" in index) {
        setFile(index);
        setDraft(index.content);
      }
    }).catch((failure: unknown) => {
      if (!dispose) setError(failure instanceof Error ? failure.message : "Could not open Agent memory.");
    }).finally(() => { if (!dispose) setBusy(false); });
    return () => { dispose = true; };
  }, [access]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setConfirmDelete(false);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not access Agent memory.");
    } finally {
      setBusy(false);
    }
  }

  async function select(noteId: string) {
    await run(async () => {
      const result = await access(noteId ? { action: "read_note", noteId } : { action: "read_index" });
      if (!("content" in result)) return;
      setFile(result);
      setSelected(noteId);
      setDraft(result.content);
      setNewNote(undefined);
    });
  }

  async function save() {
    if (!file) return;
    await run(async () => {
      const update = { content: draft, revision: file.revision };
      const result = await access(selected
        ? { ...update, action: "write_note", noteId: selected }
        : { ...update, action: "write_index" });
      if (!("content" in result)) return;
      setFile(result);
      setDraft(result.content);
      if (selected && !notes.includes(selected)) setNotes([...notes, selected].sort());
    });
  }

  async function remove() {
    if (!file || !selected) return;
    await run(async () => {
      const result = await access({ action: "delete_note", noteId: selected, revision: file.revision });
      if (!("content" in result)) return;
      setNotes(notes.filter((note) => note !== selected));
      setFile(result);
      setDraft("");
    });
  }

  return (
    <div className="agent-memory-editor" aria-busy={busy}>
      <p className="context-list__meta">Keep progress, prior reports, and lessons here. Never store secrets.</p>
      <div className="agent-memory-editor__actions">
        <label className="agent-memory-editor__file">
          File
          <select value={selected} disabled={busy || dirty} onChange={(event) => void select(event.target.value)}>
            <option value="">Index</option>
            {selected && !notes.includes(selected) ? <option value={selected}>{selected} (unsaved note)</option> : null}
            {notes.map((note) => <option key={note} value={note}>{note}</option>)}
          </select>
        </label>
        {canEdit && newNote === undefined ? (
          <button type="button" className="context-list__action" disabled={busy || dirty}
            onClick={() => setNewNote("")}>New note</button>
        ) : null}
      </div>
      {canEdit && newNote !== undefined ? (
        <div className="agent-memory-editor__actions">
          <label className="agent-memory-editor__file">
            New note ID
            <input value={newNote} maxLength={64} disabled={busy || dirty} placeholder="release-checks"
              onChange={(event) => setNewNote(event.target.value)} />
          </label>
          <button type="button" className="context-list__action"
            disabled={busy || dirty || !new RegExp(AGENT_MEMORY_NOTE_ID_PATTERN, "u").test(newNote)}
            onClick={() => void select(newNote)}>Open note</button>
          <button type="button" className="context-list__action" disabled={busy}
            onClick={() => setNewNote(undefined)}>Cancel</button>
        </div>
      ) : null}
      {file ? (
        <>
          <label>
            {selected || "Index"}
            <textarea rows={8} value={draft} readOnly={busy || !canEdit}
              onChange={(event) => setDraft(event.target.value)} />
          </label>
          <p className={size > limit ? "context-empty context-empty--error" : "context-list__meta"}>
            {size.toLocaleString()} / {limit.toLocaleString()} UTF-8 bytes
          </p>
          {canEdit ? (
            <div className="agent-memory-editor__actions">
              <button className="context-list__action" type="button" disabled={busy || !dirty || size > limit}
                onClick={() => void save()}>Save</button>
              {dirty ? <button className="context-list__action" type="button" disabled={busy}
                onClick={() => setDraft(file.content)}>Discard edits</button> : null}
              <button className="context-list__action" type="button" disabled={busy || dirty}
                onClick={() => void select(selected)}>Reload</button>
              {selected && file.exists ? (
                <button className="context-list__action context-list__action--danger" type="button"
                  disabled={busy || dirty} onClick={() => confirmDelete ? void remove() : setConfirmDelete(true)}>
                  {confirmDelete ? "Confirm delete" : "Delete note"}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {busy && !file ? <p className="context-list__meta" role="status">Loading memory…</p> : null}
      {error ? <p className="context-empty context-empty--error" role="alert">{error}</p> : null}
    </div>
  );
}
