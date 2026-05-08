/* eslint-disable */
const { useState: useStateNT, useRef: useRefNT, useEffect: useEffectNT, useMemo: useMemoNT } = React;

/* ----------------------------------------------------------------
   Project picker — sits next to the Worktree picker in the composer.
   Default is "No selected project". Opening it shows recent dirs
   (sorted by lastUsed, capped at 10) plus a "Pick directory…" action
   that simulates a native folder browser.
---------------------------------------------------------------- */
function ProjectPicker({ value, recents, onChange, onPickFromDisk }) {
  const I = window.PA.Icon;
  const [open, setOpen] = useStateNT(false);
  const [query, setQuery] = useStateNT("");
  const ref = useRefNT(null);

  useEffectNT(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const sorted = useMemoNT(() => {
    const arr = [...(recents || [])];
    arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    const top10 = arr.slice(0, 10);
    if (!query.trim()) return top10;
    const q = query.trim().toLowerCase();
    return top10.filter((d) => d.dir.toLowerCase().includes(q) || (d.path || "").toLowerCase().includes(q));
  }, [recents, query]);

  const isEmpty = !value;
  const labelClass = `pa-pick pa-pick--proj ${isEmpty ? "is-empty" : "is-active"}`;

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className={labelClass}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title={value ? `Project: ${value.dir}` : "Choose a project for this thread"}
        type="button"
      >
        <I.Folder size={11} />
        <span className="pa-pick__txt">{value ? value.dir : "No selected project"}</span>
        <span className="pa-pick__chev">▾</span>
      </button>

      {open && (
        <div className="pa-pop pa-projpop" style={{ bottom: "calc(100% + 6px)", left: 0 }}>
          <div className="pa-projpop__head">
            <I.Search size={12} />
            <input
              className="pa-projpop__search"
              placeholder="Search directories"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>

          <div className="pa-projpop__section">Recent directories</div>

          {sorted.length === 0 && (
            <div className="pa-projpop__empty">
              {query ? "No matches." : "No directories yet — pick one below."}
            </div>
          )}

          {sorted.map((d) => {
            const active = value && value.dir === d.dir;
            return (
              <button
                key={d.dir}
                className={`pa-projpop__row ${active ? "is-active" : ""}`}
                onClick={() => { onChange(d); setOpen(false); }}
                type="button"
              >
                <I.Folder size={13} />
                <span className="pa-projpop__name">{d.dir}</span>
                <span className="pa-projpop__path">{d.path || "—"}</span>
                {active && <I.Check size={12} />}
              </button>
            );
          })}

          <div className="pa-projpop__sep" />

          <button
            className="pa-projpop__row pa-projpop__row--action"
            onClick={() => { setOpen(false); onPickFromDisk(); }}
            type="button"
          >
            <I.Plus size={13} />
            <span className="pa-projpop__name">Pick directory…</span>
            <span className="pa-projpop__hint">⌘O</span>
          </button>
        </div>
      )}
    </span>
  );
}

/* ----------------------------------------------------------------
   File-browser modal — stand-in for the native Open dialog.
   Lets the user "navigate" a fake filesystem and pick a folder.
---------------------------------------------------------------- */
const FAKE_FS = {
  "/Users/huntharo": [
    { name: "github", kind: "dir" },
    { name: "Documents", kind: "dir" },
    { name: "Downloads", kind: "dir" },
    { name: "code", kind: "dir" },
    { name: "Desktop", kind: "dir" },
  ],
  "/Users/huntharo/github": [
    { name: "PwrSnap", kind: "dir", repo: true, branch: "main" },
    { name: "drvr-billing", kind: "dir", repo: true, branch: "release/2026.05" },
    { name: "site-marketing", kind: "dir", repo: true, branch: "main" },
    { name: "telemetry-pipe", kind: "dir", repo: true, branch: "main" },
    { name: "internal-docs", kind: "dir" },
  ],
  "/Users/huntharo/code": [
    { name: "scratch", kind: "dir" },
    { name: "experiments", kind: "dir", repo: true, branch: "wip" },
  ],
  "/Users/huntharo/Documents": [
    { name: "notes", kind: "dir" },
  ],
  "/Users/huntharo/Downloads": [],
  "/Users/huntharo/Desktop": [],
};

function FileBrowser({ initialPath, onCancel, onPick }) {
  const I = window.PA.Icon;
  const [path, setPath] = useStateNT(initialPath || "/Users/huntharo/github");
  const [selected, setSelected] = useStateNT(null);

  const entries = FAKE_FS[path] || [];
  const segs = path.split("/").filter(Boolean);

  const goUp = () => {
    if (segs.length <= 1) return;
    const next = "/" + segs.slice(0, -1).join("/");
    setPath(next);
    setSelected(null);
  };

  const open = (entry) => {
    const next = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    if (FAKE_FS[next]) { setPath(next); setSelected(null); }
    else setSelected(entry);
  };

  const choose = () => {
    const target = selected
      ? { name: selected.name, fullPath: `${path}/${selected.name}`, repo: !!selected.repo, branch: selected.branch || "main" }
      : { name: segs[segs.length - 1], fullPath: path, repo: entries.some(e => e.name === ".git"), branch: "main" };
    onPick(target);
  };

  return (
    <div className="pa-fb__scrim" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="pa-fb">
        <div className="pa-fb__head">
          <button className="pa-fb__nav" onClick={goUp} disabled={segs.length <= 1} title="Parent folder">
            <I.ChevronLeft size={13} />
          </button>
          <div className="pa-fb__crumbs">
            {segs.map((s, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="pa-fb__crumb-sep">/</span>}
                <button
                  className="pa-fb__crumb"
                  onClick={() => { setPath("/" + segs.slice(0, i + 1).join("/")); setSelected(null); }}
                >{s}</button>
              </React.Fragment>
            ))}
          </div>
          <button className="pa-fb__close" onClick={onCancel} title="Close">
            <I.X size={13} />
          </button>
        </div>

        <div className="pa-fb__body">
          {entries.length === 0 && <div className="pa-fb__empty">Empty folder</div>}
          {entries.map((e) => {
            const active = selected && selected.name === e.name;
            return (
              <button
                key={e.name}
                className={`pa-fb__row ${active ? "is-selected" : ""}`}
                onClick={() => setSelected(e)}
                onDoubleClick={() => open(e)}
              >
                <I.Folder size={14} />
                <span className="pa-fb__name">{e.name}</span>
                {e.repo && (
                  <span className="pa-fb__badge" title={`git · ${e.branch}`}>
                    <I.Branch size={10} />{e.branch}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="pa-fb__foot">
          <div className="pa-fb__path">
            {selected ? `${path}/${selected.name}` : path}
          </div>
          <button className="pa-fb__cancel" onClick={onCancel}>Cancel</button>
          <button
            className="pa-fb__choose"
            onClick={choose}
            disabled={!selected || (selected && !selected.repo && !FAKE_FS[`${path}/${selected.name}`])}
          >
            Choose
          </button>
        </div>
        <div className="pa-fb__hint">
          Double-click a folder to open it. Pick any directory — git repos start as worktrees, others start local.
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   New thread screen
---------------------------------------------------------------- */
function NewThread({ recents, initialProject, onCancel, onStart }) {
  const I = window.PA.Icon;
  const [project, setProject] = useStateNT(initialProject || null);
  const [text, setText] = useStateNT("");
  const [fast, setFast] = useStateNT(false);
  const [plan, setPlan] = useStateNT(false);
  const [browser, setBrowser] = useStateNT(false);
  const [worktreeMode, setWorktreeMode] = useStateNT(initialProject && !initialProject.isRepo ? "local" : "worktree"); // worktree | local

  const canStart = !!project && text.trim().length > 0;

  const start = () => {
    if (!canStart) return;
    onStart({
      project,
      text,
      worktreeMode,
      fast,
      plan,
    });
  };

  const onPickFromDisk = () => setBrowser(true);
  const onChosenFromDisk = (target) => {
    setBrowser(false);
    // Synthesize a directory entry; mark it as "new" so it gets added on start.
    setProject({
      dir: target.name,
      path: target.fullPath,
      branch: target.branch,
      isRepo: target.repo,
      isNew: true,
      lastUsed: Date.now(),
    });
    // If it's not a repo, default to local rather than worktree.
    if (!target.repo) setWorktreeMode("local");
  };

  return (
    <main className="pa-newthread">
      {browser && (
        <FileBrowser
          initialPath="/Users/huntharo/github"
          onCancel={() => setBrowser(false)}
          onPick={onChosenFromDisk}
        />
      )}

      <div className="pa-newthread__inner">
        <header className="pa-newthread__header">
          <div className="pa-newthread__eyebrow-row">
            <span className="pa-newthread__eyebrow">NEW THREAD</span>
            <span className="pa-pill2">OpenAI</span>
            <span className="pa-pill2">Full Access</span>
            <span className="pa-newthread__spacer" />
            <div className="pa-newthread__meta">
              <div className="pa-newthread__meta-col">
                <div className="pa-newthread__meta-label">Workspace</div>
                <div className="pa-newthread__meta-value">
                  {project
                    ? (worktreeMode === "worktree" && project.isRepo ? "New worktree" : "Local")
                    : "—"}
                </div>
              </div>
              <div className="pa-newthread__meta-col">
                <div className="pa-newthread__meta-label">Branch</div>
                <div className="pa-newthread__meta-value">{project?.branch || "—"}</div>
              </div>
            </div>
          </div>
          <h1 className="pa-newthread__title">
            {project ? project.dir : "Untitled"}
          </h1>
        </header>

        {project ? (
          <section className="pa-newthread__card">
            <div className="pa-newthread__card-col">
              <div className="pa-newthread__card-row">
                <div className="pa-newthread__field-label">Project</div>
                <div className="pa-newthread__field-value">{project.dir}</div>
              </div>
              <div className="pa-newthread__card-row">
                <div className="pa-newthread__field-label">Threads</div>
                <div className="pa-newthread__field-value pa-newthread__field-value--strong">
                  {project.isNew ? "0 threads (new)" : `${project.threadCount ?? 0} threads`}
                </div>
              </div>
              <div className="pa-newthread__card-row">
                <div className="pa-newthread__field-label">Status</div>
                <div className="pa-newthread__field-value">
                  {project.isNew ? "Not yet tracked" : "Up to date"}
                </div>
              </div>
            </div>
            <div className="pa-newthread__card-col">
              <div className="pa-newthread__card-row">
                <div className="pa-newthread__field-label">Path</div>
                <div className="pa-newthread__field-value pa-newthread__field-value--mono">
                  {project.path || "—"}
                </div>
              </div>
              <div className="pa-newthread__card-row">
                <div className="pa-newthread__field-label">Upstream</div>
                <div className="pa-newthread__field-value pa-newthread__field-value--mono">
                  {project.isRepo ? `origin/${project.branch || "main"}` : "—"}
                </div>
              </div>
              <div className="pa-newthread__card-row">
                <div className="pa-newthread__field-label">Current branch</div>
                <div className="pa-newthread__field-value pa-newthread__field-value--mono">
                  {project.branch || "—"}
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="pa-newthread__card pa-newthread__card--empty">
            <div className="pa-newthread__empty">
              <I.Folder size={22} />
              <div className="pa-newthread__empty-title">No project selected</div>
              <div className="pa-newthread__empty-sub">
                Pick a directory below to start the thread in. We'll add it to your Directories list.
              </div>
            </div>
          </section>
        )}

        <div className="pa-newthread__filler" />

        {/* ---- Composer ---- */}
        <div className="pa-composer">
          <div className="pa-composer__eyebrow">New thread</div>
          <div className="pa-newthread__compose-input">
            <span className="pa-slash">$ce:plan</span>
            <textarea
              className="pa-composer__textarea pa-newthread__textarea"
              placeholder="Describe what you want to do…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(); }}
              autoFocus
            />
          </div>

          <div className="pa-composer__row">
            <button className="pa-pick">OpenAI<span className="pa-pick__chev">▾</span></button>
            <button className="pa-pick"><span>Full Access</span><span className="pa-pick__chev">▾</span></button>

            {/* NEW: Project picker, sits before Worktree */}
            <ProjectPicker
              value={project}
              recents={recents}
              onChange={(d) => {
                setProject({ ...d, isNew: false, lastUsed: Date.now() });
                if (!d.isRepo) setWorktreeMode("local");
                else setWorktreeMode("worktree");
              }}
              onPickFromDisk={onPickFromDisk}
            />

            <button
              className={`pa-pick ${project && project.isRepo ? "is-active" : ""}`}
              onClick={() => {
                if (!project) return;
                setWorktreeMode((m) => m === "worktree" ? "local" : (project.isRepo ? "worktree" : "local"));
              }}
              disabled={!project}
              title={project?.isRepo ? "Toggle worktree / local" : "Local only — not a git repo"}
            >
              <I.Worktree size={11} />
              <span>{worktreeMode === "worktree" && project?.isRepo ? "New worktree" : "Local"}</span>
              <span className="pa-pick__chev">▾</span>
            </button>

            <button className="pa-pick" disabled={!project}>
              <I.Branch size={11} />
              <span>{project?.branch || "main"}</span>
              <span className="pa-pick__chev">▾</span>
            </button>

            <button className="pa-pick"><span>GPT-5.5</span><span className="pa-pick__chev">▾</span></button>
            <button className="pa-pick"><span>high</span><span className="pa-pick__chev">▾</span></button>

            <span className="pa-composer__spacer" />

            <button className={`pa-toggle2 ${fast ? "is-on" : ""}`} onClick={() => setFast(!fast)}>
              <span className="pa-toggle__box">{fast && <I.Check size={9} />}</span>
              Fast mode
            </button>
            <button className={`pa-toggle2 ${plan ? "is-on" : ""}`} onClick={() => setPlan(!plan)}>
              <span className="pa-toggle__box">{plan && <I.Check size={9} />}</span>
              Plan mode
            </button>
          </div>

          <div className="pa-composer__row">
            <button className="pa-applaunch" disabled={!project}>
              <I.VSCodeGlyph size={16} />VS Code
            </button>
            <button className="pa-applaunch" disabled={!project}>
              <I.GhosttyGlyph size={16} />Ghostty
            </button>
            <span className="pa-composer__spacer" />
            {project?.isNew && (
              <span className="pa-newthread__addnote">
                <I.Plus size={11} />
                Adds <strong>{project.dir}</strong> to Directories
              </span>
            )}
            <button className="pa-newthread__cancel" onClick={onCancel}>Cancel</button>
            <button className="pa-send" onClick={start} disabled={!canStart} title={!project ? "Pick a project first" : !text.trim() ? "Type a prompt" : "Start thread"}>
              <I.Send size={12} />
              Start thread
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

window.PA = window.PA || {};
window.PA.NewThread = NewThread;
