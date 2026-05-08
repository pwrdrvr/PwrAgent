/* eslint-disable */
const { useState: useStateTB, useRef: useRefTB, useEffect: useEffectTB } = React;

function PlatformPill({ platform, status, blink, brand = false, onClick, size = 22 }) {
  const I = window.PA.Icon;
  const Glyph = I[platform];
  return (
    <span
      className={`pa-platform ${status === "off" ? "is-disabled" : ""}`}
      onClick={onClick}
      style={{ width: size, height: size }}
      title={platform}
    >
      <Glyph size={size - 8} brand={brand} />
      <span className={`pa-platform__dot is-${status} ${blink ? "is-blink" : ""}`} />
    </span>
  );
}

function MessagingBar({ messagingOn, platforms, blinkPlatforms, onToggleMessaging, onOpenActivity }) {
  const I = window.PA.Icon;
  const [open, setOpen] = useStateTB(false);
  const ref = useRefTB(null);

  useEffectTB(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className={`pa-msgbar ${messagingOn ? "" : "is-off"}`}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="pa-msgbar__label">{messagingOn ? "Msg" : "Off"}</span>
        {platforms.map((p) => (
          <PlatformPill
            key={p.platform}
            platform={p.platform}
            status={messagingOn ? p.status : "off"}
            blink={messagingOn && blinkPlatforms.includes(p.platform)}
            brand
          />
        ))}
      </button>

      {open && (
        <div className="pa-pop pa-msgpop" style={{ top: 36, right: 0 }}>
          <div className="pa-msgpop__head">
            <div className="pa-msgpop__head-title">Messaging platforms</div>
            <button
              className={`pa-switch ${messagingOn ? "is-on" : ""}`}
              onClick={(e) => { e.stopPropagation(); onToggleMessaging(); }}
            >
              <span className="pa-switch__track"><span className="pa-switch__thumb" /></span>
              <span>{messagingOn ? "On" : "Off"}</span>
            </button>
          </div>
          {platforms.map((p) => (
            <div key={p.platform} className="pa-msgpop__row">
              <PlatformPill platform={p.platform} status={messagingOn ? p.status : "off"} brand size={28} />
              <div style={{ flex: 1 }}>
                <div className="pa-msgpop__name">{p.platform}</div>
                <div className="pa-msgpop__sub">
                  {!messagingOn ? "Globally disabled" :
                    p.status === "ok" ? `${p.threads} bound · last activity ${p.lastActivity}` :
                    p.status === "suspended" ? "Configured · suspended" :
                    p.status === "error" ? `Error: ${p.error || "connection refused"}` :
                    "Configured"}
                </div>
              </div>
              <span className={`pa-rail-msg__status ${p.status === "ok" ? "is-ok" : p.status === "error" ? "is-err" : ""}`}>
                {messagingOn ? p.status.toUpperCase() : "OFF"}
              </span>
            </div>
          ))}
          <div className="pa-msgpop__open" onClick={() => { setOpen(false); onOpenActivity(); }}>
            Open Messaging Activity →
          </div>
        </div>
      )}
    </div>
  );
}

function TitleBar(props) {
  const { screen, breadcrumb, messagingOn, platforms, blinkPlatforms,
          onToggleMessaging, onOpenActivity, onOpenSettings, onToggleRail, railOpen, onNewThread } = props;
  const I = window.PA.Icon;

  return (
    <div className="pa-tb">
      <div className="pa-tb__sb-zone">
        <div className="pa-tb__lights">
          <span className="pa-tb__light r" />
          <span className="pa-tb__light y" />
          <span className="pa-tb__light g" />
        </div>
        <I.PwrAgntLogo size={22} />
        <span style={{ flex: 1 }} />
        {onNewThread && (
          <button className="pa-tb__btn" title="New thread (\u2318N)" onClick={onNewThread}>
            <I.PlusSquare size={15} />
          </button>
        )}
      </div>

      <div className="pa-tb__divider" />

      <div className="pa-tb__main-zone">
        <div className="pa-tb__crumbs">
          {breadcrumb.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <I.ChevronRight size={11} />}
              <span className={`pa-tb__crumb ${i === breadcrumb.length - 1 ? "pa-tb__crumb--leaf" : ""}`}>
                {c.eyebrow && <span className="pa-tb__crumb-eyebrow">{c.eyebrow}</span>}
                {c.label}
              </span>
            </React.Fragment>
          ))}
        </div>

        <div className="pa-tb__spacer" />

        <MessagingBar
          messagingOn={messagingOn}
          platforms={platforms}
          blinkPlatforms={blinkPlatforms}
          onToggleMessaging={onToggleMessaging}
          onOpenActivity={onOpenActivity}
        />

        {screen === "main" && (
          <>
            <button className="pa-tb__btn" title="Settings" onClick={onOpenSettings}>
              <I.Settings size={15} />
            </button>
            <button className={`pa-tb__btn ${railOpen ? "is-active" : ""}`} title="Toggle context" onClick={onToggleRail}>
              <I.PanelRight size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

window.PA = window.PA || {};
window.PA.TitleBar = TitleBar;
window.PA.PlatformPill = PlatformPill;
