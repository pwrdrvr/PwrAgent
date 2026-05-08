/* eslint-disable */
const { useState: useStateTV, useRef: useRefTV, useEffect: useEffectTV } = React;

/* ----------------------------------------------------------------
   Markdown-ish helpers
---------------------------------------------------------------- */
const IC = ({ children }) => <code className="pa-md__inline">{children}</code>;
const B = ({ children }) => <strong>{children}</strong>;
const Em = ({ children }) => <em>{children}</em>;
const S = ({ children }) => <span style={{ textDecoration: "line-through", color: "var(--text-muted)" }}>{children}</span>;

/* ----------------------------------------------------------------
   Code / pre block
---------------------------------------------------------------- */
function CodeBlock({ lang, code }) {
  return (
    <div className="pa-md__codeblock">
      {lang && <div className="pa-md__codelang">{lang}</div>}
      <pre className="pa-md__pre"><code>{code}</code></pre>
    </div>
  );
}

/* ----------------------------------------------------------------
   Diff block — two-column line-numbered, with hunk header
---------------------------------------------------------------- */
function DiffBlock({ hunks }) {
  return (
    <div className="pa-diff">
      {hunks.map((h, hi) => (
        <React.Fragment key={hi}>
          <div className="pa-diff__hunk">{h.header}</div>
          {h.lines.map((l, li) => {
            const cls = l.t === "+" ? "is-add" : l.t === "-" ? "is-del" : "";
            const sig = l.t === "+" ? "+" : l.t === "-" ? "−" : " ";
            return (
              <div key={li} className={`pa-diff__row ${cls}`}>
                <span className="pa-diff__ln">{l.t === "+" ? "" : (l.o ?? "")}</span>
                <span className="pa-diff__ln">{l.t === "-" ? "" : (l.n ?? "")}</span>
                <span className="pa-diff__sig">{sig}</span>
                <span className="pa-diff__txt">{l.text}</span>
              </div>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------
   Single-file edit (used inside an Edited-files summary)
---------------------------------------------------------------- */
function FileEdit({ title, path, adds, dels, hunks, defaultOpen = false }) {
  const I = window.PA.Icon;
  const [open, setOpen] = useStateTV(defaultOpen);
  return (
    <div className={`pa-edit ${open ? "is-open" : ""}`}>
      <button className="pa-edit__head" onClick={() => setOpen(!open)} type="button">
        <I.ChevronDown size={11} className="pa-edit__caret" />
        <span className="pa-edit__title">{title}</span>
        <span className="pa-edit__counts">
          <span className="pa-cnt pa-cnt--del">−{dels}</span>
          <span className="pa-cnt pa-cnt--add">+{adds}</span>
        </span>
      </button>
      {open && (
        <div className="pa-edit__body">
          <div className="pa-edit__path">{path}</div>
          <div className="pa-edit__chips">
            <span className="pa-chip pa-chip--del">−{dels}</span>
            <span className="pa-chip pa-chip--add">+{adds}</span>
          </div>
          <DiffBlock hunks={hunks} />
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------
   Generic flat summary row — "Used 2 tools", "Explored 4 items",
   "Edited N files, +A, -D", "Changed N files"
   Rows live on hairlines (no per-row border).
---------------------------------------------------------------- */
function SummaryRow({ label, time, defaultOpen = false, children }) {
  const I = window.PA.Icon;
  const expandable = !!children;
  const [open, setOpen] = useStateTV(defaultOpen);
  return (
    <div className={`pa-row ${open ? "is-open" : ""} ${expandable ? "is-expandable" : ""}`}>
      <button
        className="pa-row__head"
        onClick={() => expandable && setOpen(!open)}
        type="button"
        disabled={!expandable}
      >
        <span className="pa-row__label">{label}</span>
        <span className="pa-row__time">{time}</span>
        {expandable && (
          <I.ChevronDown size={12} className="pa-row__caret" />
        )}
      </button>
      {open && expandable && <div className="pa-row__body">{children}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------
   Shell command panel — within a Used-N-tools summary
---------------------------------------------------------------- */
function ShellCall({ cmd, status = "ok", duration, cwd, output, defaultOpen = false }) {
  const I = window.PA.Icon;
  const [open, setOpen] = useStateTV(defaultOpen);
  const failed = status === "failed";
  return (
    <div className={`pa-shell ${open ? "is-open" : ""}`}>
      <button className="pa-shell__head" onClick={() => setOpen(!open)} type="button">
        <I.ChevronDown size={11} className="pa-shell__caret" />
        <span className="pa-shell__cmd">{cmd}</span>
        <span className="pa-shell__dur">({duration})</span>
      </button>
      {open && (
        <div className="pa-shell__body">
          <div className="pa-shell__bar">
            <span className="pa-shell__name">Shell</span>
            <span className={`pa-shell__status ${failed ? "is-failed" : "is-ok"}`}>
              {failed ? "Failed" : "Done"} · ran for {duration}
            </span>
          </div>
          <div className="pa-shell__btns">
            <button type="button" className="pa-shell__btn">Copy command</button>
            <button type="button" className="pa-shell__btn">Copy output</button>
          </div>
          {cwd && <div className="pa-shell__cwd">{cwd}</div>}
          <pre className="pa-shell__pre"><code>{output}</code></pre>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------
   Message renderer
---------------------------------------------------------------- */
function MessageBlock({ msg }) {
  const I = window.PA.Icon;

  if (msg.kind === "user") {
    return (
      <article className="pa-msg pa-msg--user">
        <div className="pa-msg__head">
          <span className="pa-msg__role">USER</span>
          <span className="pa-msg__time">{msg.time}</span>
        </div>
        <div className="pa-msg__body">{msg.body || <p>{msg.text}</p>}</div>
      </article>
    );
  }

  if (msg.kind === "assistant") {
    return (
      <article className="pa-msg pa-msg--assistant">
        <div className="pa-msg__head">
          <span className="pa-msg__role">ASSISTANT</span>
          <span className="pa-msg__time">{msg.time}</span>
        </div>
        <div className="pa-msg__body pa-md">{msg.body}</div>
      </article>
    );
  }

  if (msg.kind === "summary") {
    return <SummaryRow label={msg.label} time={msg.time} defaultOpen={msg.defaultOpen}>{msg.children}</SummaryRow>;
  }

  if (msg.kind === "thinking") {
    return (
      <div className="pa-thinking">
        <span className="pa-thinking__bar"><span /></span>
        <span>Thinking</span>
      </div>
    );
  }

  return null;
}

/* ----------------------------------------------------------------
   Composer (now sits flush against bottom of app)
---------------------------------------------------------------- */
function Composer({ onSend }) {
  const I = window.PA.Icon;
  const [text, setText] = useStateTV("");
  const [fast, setFast] = useStateTV(false);
  const [plan, setPlan] = useStateTV(false);
  const send = () => { if (!text.trim()) return; onSend?.(text); setText(""); };
  return (
    <div className="pa-composer">
      <div className="pa-composer__eyebrow">Reply</div>
      <textarea
        className="pa-composer__textarea"
        placeholder="Reply to this thread"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
      />
      <div className="pa-composer__row">
        <button className="pa-pick">OpenAI</button>
        <button className="pa-pick"><span>Full Access</span><span className="pa-pick__chev">▾</span></button>
        <button className="pa-pick is-active"><span>Worktree</span><span className="pa-pick__chev">▾</span></button>
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
        <button className="pa-applaunch"><I.VSCodeGlyph size={16} />VS Code</button>
        <button className="pa-applaunch"><I.GhosttyGlyph size={16} />Ghostty</button>
        <span className="pa-composer__spacer" />
        <button className="pa-pick" disabled style={{opacity:.6}}>
          <I.Activity size={11} /><span>57%</span>
        </button>
        <button className="pa-send" onClick={send} disabled={!text.trim()}>
          <I.Send size={12} />Send
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Sample turns — Issue 226 inbound identifier fuzz
---------------------------------------------------------------- */
function buildSampleTurns() {
  const I = window.PA.Icon;
  return [
    { kind: "user", time: "May 7, 11:54 PM",
      text: "Issue 226: tighten the inbound identifier fuzz tests. The desktop adapter tests still use placeholder ids like channel-1 and assert the old \"Not authorized\" controller reply — flip them to real Discord/Telegram-shaped IDs and provider-level silent drop." },

    { kind: "assistant", time: "May 7, 11:56 PM", body: (
      <>
        <h3>Quick read</h3>
        <p>Two surfaces to update — the messaging adapters under <IC>apps/desktop/src/main/__tests__</IC> and the boundary rules in <IC>packages/messaging-core/src/authorize.ts</IC>. The tests are pinned to the old "<IC>Not authorized</IC>" behavior. I'm going to run those two focused suites as a sanity check because they are directly relevant to your question.</p>
      </>
    ) },

    { kind: "summary", time: "May 8, 12:08 AM", label: "Used 2 tools", defaultOpen: true, children: (
      <>
        <ShellCall
          cmd="pnpm test apps/desktop/src/main/__tests__/telegram-adapter.test.ts"
          duration="884ms" status="ok"
          cwd="/Users/huntharo/.codex/worktrees/mowdg4o8/PwrAgnt"
          output={`> pwragent@1.0.0-alpha.0 test /Users/huntharo/.codex/worktrees/mowdg4o8/PwrAgnt
> vitest run --config vitest.workspace.ts apps/desktop/src/main/__tests__/telegram-adapter.test.ts

 RUN  v4.1.4 /Users/huntharo/.codex/worktrees/mowdg4o8/PwrAgnt

 ✓ |desktop-main| apps/desktop/src/main/__tests__/telegram-adapter.test.ts (12 tests) 220ms

Test Files  1 passed (1)
     Tests  12 passed (12)`}
        />
        <ShellCall
          defaultOpen
          cmd="pnpm test apps/desktop/src/main/__tests__/discord-adapter.test.ts"
          duration="1.1s" status="failed"
          cwd="/Users/huntharo/.codex/worktrees/mowdg4o8/PwrAgnt"
          output={`> pwragent@1.0.0-alpha.0 test /Users/huntharo/.codex/worktrees/mowdg4o8/PwrAgnt
> vitest run --config vitest.workspace.ts apps/desktop/src/main/__tests__/discord-adapter.test.ts

 RUN  v4.1.4 /Users/huntharo/.codex/worktrees/mowdg4o8/PwrAgnt

 ❯ |desktop-main| apps/desktop/src/main/__tests__/discord-adapter.test.ts (20 tests | 10 failed) 45ms
   × normalizes Discord slash command interactions  2ms
   × renders slash command responses through the deferred interaction response  3ms
   × normalizes /resume and renders a picker with components  1ms
   × normalizes /pwragnt and renders a picker  1ms
   × replies "Not authorized" when sender is not allow-listed  1ms

  ⎯⎯⎯ Failed Tests 10 ⎯⎯⎯
  AssertionError: expected "channel-1" to match /^\\d{17,20}$/`}
        />
      </>
    ) },

    { kind: "assistant", time: "May 8, 12:08 AM", body: (
      <>
        <p>Short version: not enough, and the existing desktop-side tests actually exposed the old assumptions. I just ran them and they fail under the new boundary rules because they use placeholder IDs like <IC>channel-1</IC> and also assert the old "<IC>Not authorized</IC>" controller reply, so I'm going to update those tests rather than leave the branch with hidden failures.</p>
      </>
    ) },

    { kind: "summary", time: "May 8, 12:08 AM", label: "Explored 4 items" },

    { kind: "assistant", time: "May 8, 12:08 AM", body: (
      <>
        <p>I'm going to make the desktop messaging tests use realistic platform IDs instead of old placeholders, and flip the explicit unauthorized-controller-reply assertions to provider-level silent drop where that is now the intended behavior.</p>
      </>
    ) },

    { kind: "summary", time: "May 8, 12:09 AM", label: "Explored 5 items · Used 2 tools" },

    { kind: "summary", time: "May 8, 12:09 AM", label: "Changed 1 file" },

    { kind: "summary", time: "May 8, 12:10 AM", label: "Edited 3 files, +22, −23", defaultOpen: true, children: (
      <>
        <FileEdit
          defaultOpen
          title="Update discord-adapter.test.ts"
          path="apps/desktop/src/main/__tests__/discord-adapter.test.ts"
          adds={12} dels={7}
          hunks={[
            { header: "@@ -27,6 +27,14 @@",
              lines: [
                { t: " ", o: 27, n: 27, text: "} from \"@pwragent/messaging-provider-discord\";" },
                { t: " ", o: 28, n: 28, text: "" },
                { t: " ", o: 29, n: 29, text: "const tempDirs: string[] = [];" },
                { t: "+", n: 30, text: "const DISCORD_APP_ID = \"1480556454498009350\";" },
                { t: "+", n: 31, text: "const DISCORD_CHANNEL_ID = \"1480556454498009352\";" },
                { t: "+", n: 32, text: "const DISCORD_GUILD_ID = \"1480556454498009353\";" },
                { t: "+", n: 33, text: "const DISCORD_MESSAGE_ID = \"1480556454498009354\";" },
                { t: "+", n: 34, text: "const DISCORD_USER_ID = \"1480556454498009355\";" },
                { t: "+", n: 35, text: "const DISCORD_OTHER_USER_ID = \"1480556454498009356\";" },
                { t: "+", n: 36, text: "const DISCORD_INTERACTION_ID = \"1480556454498009357\";" },
                { t: "+", n: 37, text: "const DISCORD_ATTACHMENT_ID = \"1480556454498009358\";" },
              ] },
            { header: "@@ -118,7 +126,7 @@ describe(\"discord adapter\", () => {",
              lines: [
                { t: " ", o: 118, n: 126, text: "  it(\"normalizes /pwragnt and renders a picker\", () => {" },
                { t: "-", o: 119, text: "    const evt = mkEvent({ channelId: \"channel-1\" });" },
                { t: "+", n: 127, text: "    const evt = mkEvent({ channelId: DISCORD_CHANNEL_ID });" },
                { t: " ", o: 120, n: 128, text: "    const out = adapter.handle(evt);" },
              ] },
            { header: "@@ -204,8 +212,1 @@",
              lines: [
                { t: "-", o: 204, text: "    expect(reply.text).toBe(\"Not authorized\");" },
                { t: "-", o: 205, text: "    expect(reply.kind).toBe(\"controller\");" },
                { t: "+", n: 212, text: "    expect(reply).toBeUndefined(); // provider drops silently now" },
              ] },
          ]} />
        <FileEdit
          title="Update telegram-adapter.test.ts"
          path="apps/desktop/src/main/__tests__/telegram-adapter.test.ts"
          adds={6} dels={9}
          hunks={[]} />
        <FileEdit
          title="Tweak authorize.ts thresholds"
          path="packages/messaging-core/src/authorize.ts"
          adds={4} dels={7}
          hunks={[]} />
      </>
    ) },

    { kind: "summary", time: "May 8, 12:11 AM", label: "Used 1 tool" },

    { kind: "thinking" },
  ];
}

/* ----------------------------------------------------------------
   Thread view — full-bleed transcript, composer flush at bottom
---------------------------------------------------------------- */
function ThreadView({ thread, onSend }) {
  const turns = (thread.turns && thread.turns.length > 4) ? thread.turns : buildSampleTurns();
  const scrollRef = useRefTV(null);

  /* Persist scroll position per-thread */
  useEffectTV(() => {
    const key = `pa-tx-scroll:${thread.id}`;
    const el = scrollRef.current;
    if (!el) return;
    const saved = parseInt(localStorage.getItem(key) || "-1", 10);
    if (saved >= 0) el.scrollTop = saved;
    else el.scrollTop = el.scrollHeight; // start at bottom
    const onScroll = () => localStorage.setItem(key, String(el.scrollTop));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [thread.id]);

  return (
    <main className="pa-thread">
      <section className="pa-transcript">
        <div ref={scrollRef} className="pa-transcript__scroll">
          <div className="pa-transcript__inner">
            {turns.map((m, i) => <MessageBlock key={i} msg={m} />)}
          </div>
        </div>
        <div className="pa-transcript__fade pa-transcript__fade--top" />
        <div className="pa-transcript__fade pa-transcript__fade--bottom" />
      </section>
      <Composer onSend={onSend} />
    </main>
  );
}

window.PA = window.PA || {};
window.PA.ThreadView = ThreadView;
