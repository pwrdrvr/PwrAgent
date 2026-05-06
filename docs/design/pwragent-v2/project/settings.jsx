/* eslint-disable */
const { useState: useStateSet } = React;

function Field({ label, sub, children, help }) {
  const I = window.PA.Icon;
  return (
    <div className="pa-field">
      <div>
        <div className="pa-field__label">{label}</div>
        {sub && <div className="pa-field__sub">{sub}</div>}
      </div>
      <div className="pa-field__control">
        {children}
        {help && <div className="pa-field__help"><I.Info size={12} /><span>{help}</span></div>}
      </div>
    </div>
  );
}

function Card({ eyebrow, title, chip, chipKind, children, dense }) {
  return (
    <section className="pa-card">
      <div className="pa-card__head">
        <span className="pa-card__eyebrow">{eyebrow}</span>
        <h2 className="pa-card__title">{title}</h2>
        {chip && <span className={`pa-card__chip ${chipKind || ""}`}>{chip}</span>}
      </div>
      <div className={`pa-card__body ${dense ? "pa-card__body--dense" : ""}`}>{children}</div>
    </section>
  );
}

function TestBlock({ icon, name, sub, status, onTest, lastTested }) {
  const I = window.PA.Icon;
  return (
    <div className="pa-testblock">
      <span className="pa-testblock__icon">{icon}</span>
      <div className="pa-testblock__main">
        <div className="pa-testblock__name">{name}</div>
        <div className="pa-testblock__sub">{sub}</div>
      </div>
      <span className={`pa-testblock__status is-${status}`}>
        {status === "ok" && <><I.Check size={11} /> Connected</>}
        {status === "err" && <><I.AlertTriangle size={11} /> Failed</>}
        {status === "pending" && <><I.Loader size={11} /> Testing…</>}
        {status === "idle" && <>Not tested</>}
      </span>
      {lastTested && <span style={{ font: "500 11px/1 var(--font-mono)", color: "var(--text-muted)" }}>{lastTested}</span>}
      <button className="pa-btn-sec" onClick={onTest}><I.Refresh size={12} /> Test</button>
    </div>
  );
}

function Pill({ active, children, onClick }) {
  return (
    <button className={`pa-seg__btn ${active ? "is-active" : ""}`} onClick={onClick}>{children}</button>
  );
}

/* ---------------- Section panels ---------------- */

function ApplicationsPanel() {
  const I = window.PA.Icon;
  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">Applications</div>
          <h1 className="pa-settings__head-title">Editor &amp; terminal</h1>
          <p className="pa-settings__head-help">
            Choose which apps PwrAgent opens when you click the editor or terminal launcher
            below the composer. Detected apps are listed below; pick the default for each role.
          </p>
        </div>
      </div>

      <Card eyebrow="Editor" title="Default editor">
        <div className="pa-paths">
          <div className="pa-pathrow is-active">
            <I.VSCodeGlyph size={20} />
            <div style={{ flex: 1 }}>
              <div style={{ font: "600 13px/1 var(--font-sans)", color: "var(--text-primary)" }}>VS Code</div>
              <div className="pa-pathrow__path">/Applications/Visual Studio Code.app</div>
            </div>
            <span className="pa-card__chip is-ok">Selected</span>
          </div>
          <div className="pa-pathrow">
            <I.CursorGlyph size={20} />
            <div style={{ flex: 1 }}>
              <div style={{ font: "600 13px/1 var(--font-sans)", color: "var(--text-primary)" }}>Cursor</div>
              <div className="pa-pathrow__path">/Applications/Cursor.app</div>
            </div>
            <button className="pa-btn-sec">Use</button>
          </div>
          <div className="pa-pathrow">
            <I.ZedGlyph size={20} />
            <div style={{ flex: 1 }}>
              <div style={{ font: "600 13px/1 var(--font-sans)", color: "var(--text-primary)" }}>Zed</div>
              <div className="pa-pathrow__path">/Applications/Zed.app</div>
            </div>
            <button className="pa-btn-sec">Use</button>
          </div>
        </div>
      </Card>

      <Card eyebrow="Terminal" title="Default terminal">
        <div className="pa-paths">
          <div className="pa-pathrow">
            <I.TerminalGlyph size={20} />
            <div style={{ flex: 1 }}>
              <div style={{ font: "600 13px/1 var(--font-sans)", color: "var(--text-primary)" }}>Terminal</div>
              <div className="pa-pathrow__path">/System/Applications/Utilities/Terminal.app</div>
            </div>
            <button className="pa-btn-sec">Use</button>
          </div>
          <div className="pa-pathrow is-active">
            <I.GhosttyGlyph size={20} />
            <div style={{ flex: 1 }}>
              <div style={{ font: "600 13px/1 var(--font-sans)", color: "var(--text-primary)" }}>Ghostty</div>
              <div className="pa-pathrow__path">/Applications/Ghostty.app</div>
            </div>
            <span className="pa-card__chip is-ok">Selected</span>
          </div>
        </div>
      </Card>
    </>
  );
}

function WorktreesPanel() {
  const [mode, setMode] = useStateSet("home");
  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">Worktrees</div>
          <h1 className="pa-settings__head-title">Storage &amp; cleanup</h1>
          <p className="pa-settings__head-help">
            PwrAgent creates a fresh git worktree for every thread so concurrent agents don't
            collide on your working tree. Pick where those worktrees live and how long they stick around.
          </p>
        </div>
      </div>

      <Card eyebrow="Worktrees" title="Storage location" chip="default">
        <Field label="Where should worktrees live?" sub="Pick a strategy that matches how you keep your projects on disk.">
          <div className="pa-seg">
            <Pill active={mode === "in"} onClick={() => setMode("in")}>In repository</Pill>
            <Pill active={mode === "home"} onClick={() => setMode("home")}>User home</Pill>
          </div>
          <div className="pa-field__help">
            <span>
              {mode === "home"
                ? "Outside the repository under ~/.pwragent/worktrees/<hash>/<project-folder>."
                : "Inside the repository under ./.worktrees/<hash>/."}
            </span>
          </div>
        </Field>

        <Field label="Effective path" sub="Computed from your strategy and the active project.">
          <input className="pa-input pa-input--inline" defaultValue="/Users/huntharo/.pwragent/worktrees" readOnly />
        </Field>
      </Card>

      <Card eyebrow="Cleanup" title="Auto-cleanup">
        <Field
          label="Archive idle worktrees"
          sub="Move worktrees with no activity to a parking dir."
          help="The branch and any uncommitted changes are preserved — only the working tree is removed."
        >
          <div className="pa-seg">
            <Pill>Never</Pill>
            <Pill active>After 7 days</Pill>
            <Pill>After 30 days</Pill>
          </div>
        </Field>
      </Card>
    </>
  );
}

function MessagingPanel({ platforms }) {
  const I = window.PA.Icon;
  const [tg, setTg] = useStateSet({ enabled: true, status: "ok", testing: false });
  const [dc, setDc] = useStateSet({ enabled: true, status: "ok", testing: false });

  const test = (which) => {
    const setter = which === "tg" ? setTg : setDc;
    setter((s) => ({ ...s, testing: true, status: "pending" }));
    setTimeout(() => setter((s) => ({ ...s, testing: false, status: "ok" })), 1200);
  };

  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">Messaging</div>
          <h1 className="pa-settings__head-title">Connected chat platforms</h1>
          <p className="pa-settings__head-help">
            Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone.
            Tokens are stored in the system keychain. Use the connection test on each platform
            after editing credentials — a green check below means we successfully reached the platform's API.
          </p>
        </div>
      </div>

      <Card eyebrow="Messaging" title="General" chip="default">
        <Field
          label="Tool usage notifications"
          sub="How chatty should bridged messages be when the agent runs tools?"
          help="Affects all platforms. Tweak per-thread later from the thread's context panel."
        >
          <div className="pa-seg">
            <Pill>None</Pill>
            <Pill>Less</Pill>
            <Pill active>Some</Pill>
            <Pill>More</Pill>
            <Pill>All</Pill>
          </div>
        </Field>
        <Field
          label="Input debounce"
          sub="Wait this long for split text, code blocks, images, or files before starting one agent turn."
          help="Use 0 to disable the pre-start wait. Recommended: 500ms."
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="pa-input" defaultValue="500" style={{ width: 100 }} />
            <span style={{ font: "500 11px/1 var(--font-mono)", color: "var(--text-muted)" }}>ms</span>
          </div>
        </Field>
      </Card>

      <Card
        eyebrow="Messaging"
        title="Telegram"
        chip={tg.status === "ok" ? "Connected" : tg.status === "pending" ? "Testing" : "Idle"}
        chipKind={tg.status === "ok" ? "is-ok" : tg.status === "err" ? "is-err" : ""}
      >
        <Field label="Enabled" sub="Turn the Telegram adapter on or off independently of the global messaging switch.">
          <button className={`pa-switch ${tg.enabled ? "is-on" : ""}`} onClick={() => setTg(s => ({...s, enabled: !s.enabled}))}>
            <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
            <span>{tg.enabled ? "On" : "Off"}</span>
          </button>
        </Field>
        <Field label="Bot Token" sub="Stored in the system keychain.">
          <div style={{ display: "flex", gap: 6 }}>
            <input className="pa-input pa-input--inline" type="password" defaultValue="•••••••••••••" />
            <button className="pa-btn-sec">Replace</button>
            <button className="pa-btn-sec">Clear</button>
          </div>
        </Field>
        <Field label="Connection test" sub="Pings getMe on the Telegram Bot API.">
          <TestBlock
            icon={<I.Telegram size={18} brand />}
            name="@pwragent_bot"
            sub="api.telegram.org · last test 2m ago"
            status={tg.testing ? "pending" : tg.status}
            onTest={() => test("tg")}
          />
        </Field>
        <Field label="Streaming responses" sub="Send partial assistant tokens as Telegram message edits."
               help="Disable on slow networks or shared chats to reduce edit-rate.">
          <button className="pa-switch is-on">
            <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
            <span>On</span>
          </button>
        </Field>
        <Field label="Authorized User IDs" sub="Comma-separated Telegram user IDs that can DM the bot.">
          <input className="pa-input" defaultValue="8460800771" />
        </Field>
      </Card>

      <Card
        eyebrow="Messaging"
        title="Discord"
        chip={dc.status === "ok" ? "Connected" : dc.status === "pending" ? "Testing" : "Idle"}
        chipKind={dc.status === "ok" ? "is-ok" : dc.status === "err" ? "is-err" : ""}
      >
        <Field label="Enabled">
          <button className={`pa-switch ${dc.enabled ? "is-on" : ""}`} onClick={() => setDc(s => ({...s, enabled: !s.enabled}))}>
            <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
            <span>{dc.enabled ? "On" : "Off"}</span>
          </button>
        </Field>
        <Field label="Bot Token" sub="Stored in the system keychain.">
          <div style={{ display: "flex", gap: 6 }}>
            <input className="pa-input pa-input--inline" type="password" defaultValue="•••••••••••••" />
            <button className="pa-btn-sec">Replace</button>
            <button className="pa-btn-sec">Clear</button>
          </div>
        </Field>
        <Field label="Connection test" sub="Validates token via /users/@me on the Discord API.">
          <TestBlock
            icon={<I.Discord size={18} brand />}
            name="PwrAgent#4421"
            sub="discord.com/api · last test 14m ago"
            status={dc.testing ? "pending" : dc.status}
            onTest={() => test("dc")}
          />
        </Field>
      </Card>
    </>
  );
}

function ModelsPanel() {
  const I = window.PA.Icon;
  const [codexStatus, setCodexStatus] = useStateSet("ok");
  const [grokStatus, setGrokStatus] = useStateSet("idle");

  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">Models</div>
          <h1 className="pa-settings__head-title">Backends &amp; credentials</h1>
          <p className="pa-settings__head-help">
            PwrAgent drives Codex and Grok app-servers. Use Auto Discovery to track the newest binary
            on disk, or pin a specific path. Test each backend after changes — a green check below
            confirms we can reach the binary or the API.
          </p>
        </div>
      </div>

      <Card eyebrow="Models" title="Codex" chip="config">
        <Field label="Codex selection" sub="Pick the Codex binary to invoke for new threads.">
          <div className="pa-seg">
            <Pill active>Auto Discovery — Use Newest</Pill>
            <Pill>Specified Path</Pill>
          </div>
        </Field>

        <Field label="Available paths" sub="Detected on this machine. The first listed will be used.">
          <div className="pa-paths">
            <div className="pa-pathrow is-active">
              <span className="pa-pathrow__path">/Applications/Codex.app/Contents/Resources/codex</span>
              <div className="pa-pathrow__chips">
                <span className="pa-card__chip">application</span>
                <span className="pa-card__chip">0.128.0-alpha.1</span>
                <span className="pa-card__chip is-ok">Using</span>
              </div>
            </div>
            <div className="pa-pathrow">
              <span className="pa-pathrow__path">/opt/homebrew/bin/codex</span>
              <div className="pa-pathrow__chips">
                <span className="pa-card__chip">path</span>
                <span className="pa-card__chip">0.125.0</span>
                <span className="pa-card__chip">Available</span>
              </div>
              <button className="pa-btn-sec">Use</button>
            </div>
          </div>
        </Field>

        <Field label="Connection test" sub="Spawns codex --version and validates the version banner.">
          <TestBlock
            icon={<span className="pa-app-glyph" style={{ width: 20, height: 20, background: "#0d6efd" }}>C</span>}
            name="codex --version"
            sub="0.128.0-alpha.1 · pid 47821"
            status={codexStatus}
            onTest={() => { setCodexStatus("pending"); setTimeout(() => setCodexStatus("ok"), 900); }}
          />
        </Field>
      </Card>

      <Card eyebrow="Models" title="Grok" chip="Set · keychain">
        <Field label="API Key" sub="x.ai API key. Stored in the system keychain.">
          <div style={{ display: "flex", gap: 6 }}>
            <input className="pa-input" type="password" defaultValue="••••••••••••••••••••••••••" />
            <button className="pa-btn-sec">Replace</button>
            <button className="pa-btn-sec">Clear</button>
          </div>
        </Field>
        <Field label="Connection test" sub="Calls GET /v1/models on the Grok API.">
          <TestBlock
            icon={<span className="pa-app-glyph" style={{ width: 20, height: 20, background: "#171717" }}>X</span>}
            name="api.x.ai/v1/models"
            sub="grok-2-1212, grok-2-mini, grok-3"
            status={grokStatus}
            onTest={() => { setGrokStatus("pending"); setTimeout(() => setGrokStatus("ok"), 900); }}
          />
        </Field>
      </Card>
    </>
  );
}

function ExperimentalPanel() {
  const I = window.PA.Icon;
  const [diffElide, setDiffElide] = useStateSet(true);
  const [mode, setMode] = useStateSet("auto");
  const [model, setModel] = useStateSet("haiku-4.5");
  const [composer, setComposer] = useStateSet("tiptap-wysiwyg");

  const COMPOSER_OPTIONS = [
    {
      id: "textarea",
      title: "Plain textarea",
      sub: "Native browser textarea. No formatting, no chips. Smallest surface, most predictable.",
      isDefault: false,
    },
    {
      id: "tiptap-raw",
      title: "TipTap · raw Markdown",
      sub: "TipTap editor that shows Markdown source. Slash menu inserts chips for models, worktrees, and access modes.",
      isDefault: false,
    },
    {
      id: "tiptap-wysiwyg",
      title: "TipTap · WYSIWYG Markdown",
      sub: "Renders Markdown as you type. Bold, links, lists, and chips appear inline. The default for new users.",
      isDefault: true,
    },
    {
      id: "custom-chips",
      title: "Custom widget with chips",
      sub: "In-house composer built around chip primitives. No Markdown parser; chips are first-class tokens.",
      isDefault: false,
    },
  ];

  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">Experimental</div>
          <h1 className="pa-settings__head-title">Experimental features</h1>
          <p className="pa-settings__head-help">
            Opt-in features that may change shape or be removed without notice. Issues here are
            best filed with logs attached — see <a className="pa-link">docs/experimental.md</a>.
          </p>
        </div>
      </div>

      <Card eyebrow="Experimental" title="Diff Eliding" chip={diffElide ? "On" : "Off"} chipKind={diffElide ? "is-ok" : ""}>
        <Field
          label="Enabled"
          sub="Compress unchanged hunks of large diffs before sending them to the agent. Reduces token usage on big rebases."
        >
          <button className={`pa-switch ${diffElide ? "is-on" : ""}`} onClick={() => setDiffElide(!diffElide)}>
            <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
            <span>{diffElide ? "On" : "Off"}</span>
          </button>
        </Field>

        {diffElide && (
          <>
            <Field
              label="Eliding model"
              sub="Which model decides which hunks to elide?"
              help="Auto matches the thread's primary model: Codex threads use Codex; Grok threads use Grok. Manual pins a single model for all eliding requests regardless of thread."
            >
              <div className="pa-seg">
                <Pill active={mode === "auto"} onClick={() => setMode("auto")}>Auto (match thread)</Pill>
                <Pill active={mode === "manual"} onClick={() => setMode("manual")}>Specific model</Pill>
              </div>
            </Field>

            {mode === "manual" && (
              <Field label="Pinned model" sub="Used for every diff-eliding request.">
                <div className="pa-seg">
                  <Pill active={model === "haiku-4.5"} onClick={() => setModel("haiku-4.5")}>claude-haiku-4-5</Pill>
                  <Pill active={model === "gpt-5.5"} onClick={() => setModel("gpt-5.5")}>gpt-5.5</Pill>
                  <Pill active={model === "grok-3"} onClick={() => setModel("grok-3")}>grok-3</Pill>
                  <Pill active={model === "codex-fast"} onClick={() => setModel("codex-fast")}>codex-fast</Pill>
                </div>
              </Field>
            )}

            <Field
              label="Threshold"
              sub="Only elide diffs larger than this size (bytes)."
              help="Smaller diffs are sent verbatim — eliding adds latency that's not worth it under this size."
            >
              <input className="pa-input pa-input--inline" defaultValue="8192" />
            </Field>
          </>
        )}
      </Card>

      <Card eyebrow="Experimental" title="Composer" chip={composer === "tiptap-wysiwyg" ? "Default" : "Overridden"} chipKind={composer === "tiptap-wysiwyg" ? "is-ok" : "is-warn"}>
        <Field
          label="Reply composer"
          sub="Which input is rendered below the transcript when you reply to a thread."
          help="Changing this swaps the editor immediately for new threads. Open threads keep their current composer until you reload them."
        >
          <div className="pa-comp-opts">
            {COMPOSER_OPTIONS.map((o) => {
              const active = composer === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  className={`pa-comp-opt ${active ? "is-active" : ""}`}
                  onClick={() => setComposer(o.id)}
                >
                  <span className={`pa-comp-opt__radio ${active ? "is-on" : ""}`}>
                    {active && <span className="pa-comp-opt__radio-dot" />}
                  </span>
                  <span className="pa-comp-opt__text">
                    <span className="pa-comp-opt__title">
                      {o.title}
                      {o.isDefault && <span className="pa-comp-opt__defbadge">Default</span>}
                    </span>
                    <span className="pa-comp-opt__sub">{o.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
      </Card>

      <Card eyebrow="Experimental" title="Other">
        <Field label="Streaming markdown previews" sub="Render assistant markdown incrementally as tokens arrive.">
          <button className="pa-switch is-on">
            <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
            <span>On</span>
          </button>
        </Field>
        <Field label="Plan-mode auto-apply" sub="Skip the apply confirmation in Plan mode runs.">
          <button className="pa-switch">
            <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
            <span>Off</span>
          </button>
        </Field>
      </Card>
    </>
  );
}

function AboutPanel() {
  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">About</div>
          <h1 className="pa-settings__head-title">PwrAgent</h1>
          <p className="pa-settings__head-help">Thread-centric coding agent. Built by PwrDrvr LLC.</p>
        </div>
        <button className="pa-btn-sec">Check for updates</button>
      </div>
      <Card eyebrow="About" title="Build">
        <dl className="pa-aboutkv">
          <div><dt>Version</dt><dd>1.0.0-alpha.3</dd></div>
          <div><dt>Copyright</dt><dd>© 2026 PwrDrvr LLC. All rights reserved.</dd></div>
          <div><dt>Website</dt><dd><a>https://pwrdrvr.com</a></dd></div>
          <div><dt>Electron</dt><dd>41.2.1</dd></div>
          <div><dt>Chromium</dt><dd>146.0.7680.188</dd></div>
          <div><dt>Node</dt><dd>24.14.1</dd></div>
        </dl>
      </Card>
    </>
  );
}

const SECTIONS = [
  { id: "applications", label: "Applications", icon: "VSCodeGlyph" },
  { id: "worktrees", label: "Worktrees", icon: "Worktree" },
  { id: "messaging", label: "Messaging", icon: "Activity", badge: true },
  { id: "models", label: "Models", icon: "Zap" },
  { id: "experimental", label: "Experimental", icon: "Loader" },
  { id: "about", label: "About", icon: "Info" },
];

function Settings({ section, setSection, onExit, platforms }) {
  const I = window.PA.Icon;
  return (
    <div className="pa-settings">
      <nav className="pa-settings__nav">
        <button className="pa-settings__exit" onClick={onExit}>
          <I.ArrowLeft size={13} /> Exit Settings
        </button>
        <div className="pa-settings__nav-group">General</div>
        {SECTIONS.map((s) => {
          const Glyph = s.icon === "VSCodeGlyph" ? () => <I.VSCodeGlyph size={14} /> : I[s.icon];
          return (
            <button
              key={s.id}
              className={`pa-settings__nav-item ${section === s.id ? "is-active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              <Glyph size={14} />
              {s.label}
              {s.badge && <span className="pa-settings__nav-badge" />}
            </button>
          );
        })}
      </nav>

      <main className="pa-settings__main">
        {section === "applications" && <ApplicationsPanel />}
        {section === "worktrees" && <WorktreesPanel />}
        {section === "messaging" && <MessagingPanel platforms={platforms} />}
        {section === "models" && <ModelsPanel />}
        {section === "experimental" && <ExperimentalPanel />}
        {section === "about" && <AboutPanel />}
      </main>
    </div>
  );
}

window.PA = window.PA || {};
window.PA.Settings = Settings;
window.PA.SETTINGS_SECTIONS = SECTIONS;
