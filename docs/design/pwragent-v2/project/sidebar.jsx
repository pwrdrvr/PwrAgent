/* eslint-disable */
const { useState: useStateSB, useRef: useRefSB, useEffect: useEffectSB } = React;

const REACTION_EMOJIS = ["👀", "✅", "❌", "🤔", "🚀", "😢", "🔁", "📌"];

function ReactionPicker({ onPick, onClose }) {
  const ref = useRefSB(null);
  useEffectSB(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div ref={ref} className="pa-pop pa-reactpicker" style={{ top: "100%", right: 0, marginTop: 4 }}>
      {REACTION_EMOJIS.map((e) => (
        <button key={e} className="pa-reactpicker__btn" onClick={(ev) => { ev.stopPropagation(); onPick(e); }}>{e}</button>
      ))}
    </div>
  );
}

function PRChip({ pr }) {
  const cls = pr.merged ? "is-merged" : pr.passing ? "is-passing" : pr.failing ? "is-failing" : "is-draft";
  const label = pr.repoPath ? `${pr.repoPath}#${pr.num}` : `#${pr.num}`;
  return (
    <span className="pa-prchip" title={`PR ${label}: ${pr.merged ? "merged" : pr.passing ? "passing" : pr.failing ? "failing" : "draft"}`}>
      <span className={`pa-prchip__dot ${cls}`} />
      {pr.repoPath && <span className="pa-prchip__path">{pr.repoPath}</span>}
      <span className="pa-prchip__num">#{pr.num}</span>
    </span>
  );
}

function ThreadPlatformChip({ platform, status, blink, onUnbind }) {
  const I = window.PA.Icon;
  const Glyph = I[platform];
  const [open, setOpen] = useStateSB(false);
  const ref = useRefSB(null);
  useEffectSB(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <span className="pa-tr__platform" title={`${platform} bound`} onClick={() => setOpen(!open)}>
        <Glyph size={11} brand />
        <span className={`pa-platform__dot is-${status} ${blink ? "is-blink" : ""}`} />
      </span>
      {open && (
        <div className="pa-pop" style={{ top: "100%", left: 0, marginTop: 4, minWidth: 200 }}>
          <div className="pa-pop__title">{platform}</div>
          <div className="pa-pop__row">
            <I.ExternalLink size={14} />
            Open in {platform}
          </div>
          <div className="pa-pop__row">
            <I.Activity size={14} />
            View activity
          </div>
          <div className="pa-pop__sep" />
          <div className="pa-pop__row is-danger" onClick={() => { setOpen(false); onUnbind?.(); }}>
            <I.Unlink size={14} />
            Unbind from {platform}
          </div>
        </div>
      )}
    </span>
  );
}

function ThreadRow({ thread, selected, onClick, onAddReaction, onUnbindPlatform }) {
  const I = window.PA.Icon;
  const [picker, setPicker] = useStateSB(false);
  const cls = ["pa-tr", selected ? "is-selected" : "", (thread.reactions||[]).length ? "has-reactions" : ""].filter(Boolean).join(" ");
  return (
    <button className={cls} onClick={onClick} style={{ position: "relative" }}>
      <div className="pa-tr__head">
        {thread.working && <span className="pa-tr__working-dot" title="Working…" />}
        {(thread.platforms || []).length > 0 && (
          <span className="pa-tr__platforms">
            {thread.platforms.map((p) => (
              <ThreadPlatformChip
                key={p.platform}
                platform={p.platform}
                status={p.status}
                blink={p.blink}
                onUnbind={() => onUnbindPlatform?.(thread.id, p.platform)}
              />
            ))}
          </span>
        )}
        <div className="pa-tr__title">{thread.title}</div>
        <div className="pa-tr__time">{thread.time}</div>
      </div>
      <div className="pa-tr__chips">
        {(thread.chips || []).map((c, i) => (
          <span key={i} className={`pa-chip2 ${c.accent ? "pa-chip2--accent" : ""}`}>
            {c.icon === "head" && <I.Branch size={10} />}
            {c.label || c}
          </span>
        ))}
        {thread.branch && (
          <span className="pa-branch2">
            <I.Branch size={11} />
            {thread.branch}
          </span>
        )}
      </div>
      {((thread.prs && thread.prs.length) || (thread.reactions && thread.reactions.length) || true) && (
        <div className="pa-tr__row-end">
          {(thread.prs || []).map((pr, i) => <PRChip key={i} pr={pr} />)}
          {(thread.reactions || []).map((r, i) => (
            <span key={i} className={`pa-react ${r.mine ? "is-mine" : ""}`} onClick={(e) => e.stopPropagation()}>
              <span className="pa-react__emoji">{r.emoji}</span>
              {r.count > 1 && r.count}
            </span>
          ))}
          <span
            className="pa-react pa-react--add"
            onClick={(e) => { e.stopPropagation(); setPicker(!picker); }}
            title="Add reaction"
          >
            <I.Smile size={12} />
          </span>
          {picker && (
            <ReactionPicker
              onPick={(emoji) => { setPicker(false); onAddReaction?.(thread.id, emoji); }}
              onClose={() => setPicker(false)}
            />
          )}
        </div>
      )}
    </button>
  );
}

function LensSwitch({ value, onChange }) {
  const opts = ["Inbox", "Recents", "Directories"];
  return (
    <div className="pa-sb__lens">
      {opts.map((o) => (
        <button key={o} className={`pa-sb__lens-btn${value === o ? " is-active" : ""}`} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function DirectoryGroup({ group, selectedId, onSelect, onAddReaction, onUnbindPlatform }) {
  const I = window.PA.Icon;
  return (
    <div className="pa-dir-section">
      <div className="pa-dir-sticky">
        <span className="pa-dir-sticky__icon"><I.Folder size={14} /></span>
        <span className="pa-dir-sticky__title">{group.dir}</span>
        <span className="pa-dir-sticky__count">{group.threads.length}</span>
        <button className="pa-dir-sticky__action" title="New thread in this folder"><I.Plus size={13} /></button>
        <button className="pa-dir-sticky__action" title="Collapse"><I.ChevronDown size={13} /></button>
      </div>
      {group.threads.map((t) => (
        <ThreadRow
          key={t.id}
          thread={t}
          selected={t.id === selectedId}
          onClick={() => onSelect(t.id)}
          onAddReaction={onAddReaction}
          onUnbindPlatform={onUnbindPlatform}
        />
      ))}
    </div>
  );
}

function Sidebar({ data, selectedId, onSelect, lens, setLens, contextDir, contextBranch, showDevContext, onAddReaction, onUnbindPlatform, onNewThread }) {
  const I = window.PA.Icon;
  const flat = data.flatMap((g) => g.threads);
  return (
    <aside className="pa-sb">
      {showDevContext && (
        <div className="pa-sb__header">
          <div className="pa-sb__row">
            <span className="pa-sb__chip-context" title="Dev-only: active folder">
              <I.Folder size={13} />
              <span className="pa-sb__chip-context__text">{contextDir}</span>
              <span className="pa-sb__chip-context__badge">dev</span>
            </span>
          </div>
          <div className="pa-sb__row">
            <span className="pa-sb__chip-context" title="Dev-only: active branch">
              <I.Branch size={13} />
              <span className="pa-sb__chip-context__text">{contextBranch}</span>
            </span>
          </div>
        </div>
      )}

      <div className="pa-sb__newthread-row">
        <button className="pa-sb__newthread" type="button" onClick={onNewThread}>
          <I.PlusSquare size={14} />
          <span>New thread</span>
          <span className="pa-sb__newthread-kbd">⌘N</span>
        </button>
      </div>

      <LensSwitch value={lens} onChange={setLens} />

      <div className="pa-sb__list">
        {(lens === "Inbox" || lens === "Recents") && flat.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            selected={t.id === selectedId}
            onClick={() => onSelect(t.id)}
            onAddReaction={onAddReaction}
            onUnbindPlatform={onUnbindPlatform}
          />
        ))}
        {lens === "Directories" && data.map((g) => (
          <DirectoryGroup
            key={g.dir}
            group={g}
            selectedId={selectedId}
            onSelect={onSelect}
            onAddReaction={onAddReaction}
            onUnbindPlatform={onUnbindPlatform}
          />
        ))}
      </div>
    </aside>
  );
}

window.PA = window.PA || {};
window.PA.Sidebar = Sidebar;
