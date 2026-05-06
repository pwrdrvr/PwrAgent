/* eslint-disable */
const { useState: useStateRR } = React;

function RailMessagingRow({ p, messagingOn }) {
  const I = window.PA.Icon;
  const Glyph = I[p.platform];
  const status = !messagingOn ? "off" : p.status;
  return (
    <div className="pa-rail-msg__row">
      <span className="pa-platform" style={{ width: 24, height: 24 }}>
        <Glyph size={14} brand />
        <span className={`pa-platform__dot is-${status} ${p.blink && messagingOn ? "is-blink" : ""}`} />
      </span>
      <div className="pa-rail-msg__name">{p.platform}</div>
      <span className={`pa-rail-msg__status ${status === "ok" ? "is-ok" : status === "error" ? "is-err" : ""}`}>
        {!messagingOn ? "OFF" : p.status === "ok" ? "ONLINE" : p.status === "suspended" ? "PAUSED" : p.status === "error" ? "ERROR" : "—"}
      </span>
    </div>
  );
}

function RightRail({ thread, platforms, messagingOn, onToggleMessaging, onOpenActivity, onClose }) {
  const I = window.PA.Icon;
  return (
    <aside className="pa-rail">
      <header className="pa-rail__header">
        <span className="pa-rail__eyebrow">Context</span>
        <button className="pa-rail__btn"><I.Eye size={12} /> Auto-hide</button>
        <button className="pa-rail__btn"><I.Pin size={12} /> Pin</button>
      </header>
      <div className="pa-rail__body">

        <div className="pa-rail__section">
          <div className="pa-rail__section-title">Linked directories</div>
          <div className="pa-server">
            <span className="pa-server__dot" style={{background: "var(--accent)"}} />
            <div style={{flex:1}}>
              <div className="pa-server__name">PwrAgent</div>
              <div className="pa-server__sub">github/pwrdrvr · worktree</div>
            </div>
          </div>
        </div>

        <div className="pa-rail__section">
          <div className="pa-rail__section-title">Messaging</div>
          <div className="pa-rail-msg">
            <div className="pa-rail-msg__row">
              <I.Activity size={13} style={{color: "var(--text-muted)"}} />
              <div className="pa-rail-msg__name">Global</div>
              <button
                className={`pa-switch ${messagingOn ? "is-on" : ""}`}
                onClick={onToggleMessaging}
              >
                <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
                <span>{messagingOn ? "On" : "Off"}</span>
              </button>
            </div>
            {platforms.map((p) => (
              <RailMessagingRow key={p.platform} p={p} messagingOn={messagingOn} />
            ))}
            <button className="pa-rail__btn" style={{alignSelf:"flex-start", marginTop:4}} onClick={onOpenActivity}>
              <I.ExternalLink size={11} /> Open activity
            </button>
          </div>
        </div>

        <div className="pa-rail__section">
          <div className="pa-rail__section-title">Execution context</div>
          <dl className="pa-rail__kv">
            <dt>Backend</dt><dd>codex</dd>
            <dt>Thread ID</dt><dd>019df3a5-4789-…-bfb81</dd>
            <dt>Access</dt><dd>Full Access</dd>
            <dt>Branch</dt><dd>fix/directory-launchpad-worktree-dedupe</dd>
            <dt>Updated</dt><dd>May 4, 1:59 PM</dd>
            <dt>Desktop</dt><dd>darwin</dd>
          </dl>
        </div>

        <div className="pa-rail__section">
          <div className="pa-rail__section-title">App servers</div>
          <div className="pa-server">
            <span className="pa-server__dot" />
            <div style={{flex:1}}>
              <div className="pa-server__name">OpenAI</div>
              <div className="pa-server__sub">Available · pro plan · 100% left, resets 6:53 PM</div>
            </div>
          </div>
          <div className="pa-server">
            <span className="pa-server__dot" />
            <div style={{flex:1}}>
              <div className="pa-server__name">Grok</div>
              <div className="pa-server__sub">Available</div>
            </div>
          </div>
        </div>

      </div>
    </aside>
  );
}

window.PA = window.PA || {};
window.PA.RightRail = RightRail;
