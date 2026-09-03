/* eslint-disable */
/* Provider-nav prototype — shared primitives. Mirrors the shipped
   SettingsLayout vocabulary (SettingsSection / SettingsField / chips)
   plus the new expandable nav-tree pattern. */

window.PN = window.PN || {};

/* ---- atoms ---- */

function PNCaret({ open }) {
  return <span className={`pn-caret${open ? " is-open" : ""}`} aria-hidden="true" />;
}

function PNChip({ kind, children }) {
  return <span className={`pn-chip${kind ? ` pn-chip--${kind}` : ""}`}>{children}</span>;
}

function PNBtn({ kind, sm, wide, disabled, onClick, children, title }) {
  const cls = [
    "pn-btn",
    kind ? `pn-btn--${kind}` : "",
    sm ? "pn-btn--sm" : "",
    wide ? "pn-btn--wide" : "",
  ].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

function PNSwitch({ on, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      className={`pn-switch${on ? " is-on" : ""}`}
      onClick={() => onChange && onChange(!on)}
    >
      <span className="pn-switch__track"><span className="pn-switch__thumb" /></span>
      <span>{on ? "On" : "Off"}</span>
    </button>
  );
}

function PNSeg({ options, value, onChange }) {
  return (
    <div className="pn-seg">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`pn-seg__btn${o === value ? " is-active" : ""}`}
          onClick={() => onChange && onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function PNSelectChip({ children, onClick }) {
  return <button type="button" className="pn-selectchip" onClick={onClick}>{children}</button>;
}

/* ---- section / field ---- */

function PNSection({ id, eyebrow, title, desc, chip, chipKind, collapsed, onToggle, headerless, refFn, children }) {
  if (headerless) {
    return (
      <section id={id} ref={refFn} className="pn-panel" data-screen-label={title}>
        <div className="pn-fields">{children}</div>
      </section>
    );
  }
  return (
    <section id={id} ref={refFn} className={`pn-panel${collapsed ? " is-collapsed" : ""}`} data-screen-label={title}>
      <div
        className="pn-panel__header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={title}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle && onToggle(); }
        }}
      >
        <span className="pn-disc" aria-hidden="true" />
        <div className="pn-panel__header-main">
          {eyebrow && <p className="pn-panel__eyebrow">{eyebrow}</p>}
          <h2 className="pn-panel__title">{title}</h2>
          {desc && <p className="pn-panel__desc">{desc}</p>}
        </div>
        <span className="pn-panel__actions">
          {chip && <PNChip kind={chipKind}>{chip}</PNChip>}
        </span>
      </div>
      <div className="pn-body-clip" aria-hidden={!!collapsed}>
        <div className="pn-body"><div className="pn-fields">{children}</div></div>
      </div>
    </section>
  );
}

function PNField({ label, sub, tags, help, children }) {
  return (
    <div className="pn-field">
      <div className="pn-field__label">
        <span>{label}</span>
        {sub && <span className="pn-field__sub">{sub}</span>}
        {tags && (
          <span className="pn-field__tags">
            {tags.map((t) => <span key={t} className="pn-tag">{t}</span>)}
          </span>
        )}
      </div>
      <div className="pn-field__control">
        {children}
        {help && <div className="pn-field__help">{help}</div>}
      </div>
    </div>
  );
}

function PNPathRow({ title, note, path, chips, selected, action, onAction }) {
  return (
    <div className={`pn-pathrow${selected ? " is-selected" : ""}`}>
      <div className="pn-pathrow__main">
        {title && (
          <span className="pn-pathrow__title">
            {title}
            {note && <span className="pn-pathrow__title-note">{note}</span>}
          </span>
        )}
        {path && <span className="pn-pathrow__path">{path}</span>}
      </div>
      <span className="pn-pathrow__chips">
        {(chips || []).map((c, i) => <PNChip key={i} kind={c.kind}>{c.label}</PNChip>)}
        {action && <PNBtn sm onClick={onAction}>{action}</PNBtn>}
      </span>
    </div>
  );
}

function PNTestBlock({ glyph, name, sub, status, onTest }) {
  const label =
    status === "ok" ? "Connected"
    : status === "testing" ? "Testing…"
    : status === "err" ? "Failed"
    : "Not tested";
  const statusCls =
    status && status !== "idle" ? ` pn-testblock__status--${status}` : "";
  return (
    <div className="pn-testblock">
      <span className="pn-testblock__icon">{glyph}</span>
      <div className="pn-testblock__main">
        <div className="pn-testblock__name">{name}</div>
        <div className="pn-testblock__sub">{sub}</div>
      </div>
      <span className={`pn-testblock__status${statusCls}`}>{label}</span>
      <PNBtn sm onClick={onTest}>Test</PNBtn>
    </div>
  );
}

/* ---- pane head, strip, index ---- */

function PNHead({ eyebrow, title, help, actions }) {
  return (
    <div className="pn-head">
      <div className="pn-head__text">
        <p className="pn-head__eyebrow">{eyebrow}</p>
        <h1 className="pn-head__title">{title}</h1>
        {help && <p className="pn-head__help">{help}</p>}
      </div>
      {actions && <div className="pn-head__actions">{actions}</div>}
    </div>
  );
}

function PNStrip({ eyebrow, label, chips, actionLabel, onAction }) {
  return (
    <div className="pn-strip">
      <span className="pn-strip__eyebrow">{eyebrow}</span>
      <span className="pn-strip__label">{label}</span>
      <span className="pn-strip__meta">
        {(chips || []).map((c, i) => <span key={i} className="pn-strip__chip">{c}</span>)}
      </span>
      <PNBtn sm kind="ghost" onClick={onAction}>{actionLabel}</PNBtn>
    </div>
  );
}

function PNIndexRow({ glyph, name, meta, chips, off, onOpen }) {
  return (
    <button type="button" className={`pn-index__row${off ? " is-off" : ""}`} onClick={onOpen}>
      <span className="pn-index__glyph">{glyph}</span>
      <span className="pn-index__main">
        <span className="pn-index__name">{name}</span>
        <span className="pn-index__meta">{meta}</span>
      </span>
      {(chips || []).map((c, i) => <PNChip key={i} kind={c.kind}>{c.label}</PNChip>)}
      <span className="pn-index__open">Open <span aria-hidden="true">›</span></span>
    </button>
  );
}

function PNKv({ rows }) {
  return (
    <dl className="pn-kv">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/* ---- nav tree ---- */

function PNNavParent({ item, active, open, onOpenToggle, onNavigate, children }) {
  const expandable = !!item.children;
  return (
    <>
      <div className={`pn-nav__row${active ? " is-active" : ""}`}>
        {expandable ? (
          <button
            type="button"
            className="pn-nav__caret"
            aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); onOpenToggle(item.id); }}
          >
            <PNCaret open={open} />
          </button>
        ) : (
          <span className="pn-nav__caret-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="pn-nav__button"
          aria-current={active ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
        >
          {item.label}
        </button>
      </div>
      {expandable && (
        <div className={`pn-nav__sublist${open ? " is-open" : ""}`} aria-hidden={!open}>
          <div className="pn-nav__sublist-clip">{children}</div>
        </div>
      )}
    </>
  );
}

function PNNavSub({ sub, active, onClick }) {
  return (
    <button
      type="button"
      className={`pn-nav__subbutton${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {sub.dot && (
        <span
          className={`pn-nav__subdot${sub.dot !== "idle" ? ` pn-nav__subdot--${sub.dot}` : ""}`}
          aria-hidden="true"
        />
      )}
      <span className="pn-nav__sublabel">{sub.label}</span>
      {sub.chip && <span className="pn-nav__subchip">{sub.chip}</span>}
    </button>
  );
}

function PNTitlebar({ crumbs, mode, setMode, modes }) {
  return (
    <div className="pn-titlebar">
      <div className="pn-titlebar__breadcrumb">
        <span className="pn-titlebar__eyebrow">Settings</span>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <span className="pn-titlebar__separator">›</span>
            {c.onClick ? (
              <button type="button" className="pn-titlebar__crumb" onClick={c.onClick}>{c.label}</button>
            ) : (
              <span className="pn-titlebar__current">{c.label}</span>
            )}
          </React.Fragment>
        ))}
      </div>
      <span className="pn-titlebar__spacer" />
      <div className="pn-modeswitch" title="Prototype-only: switch the navigation model">
        <span className="pn-modeswitch__label">nav model</span>
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`pn-modeswitch__btn${mode === m.id ? " is-active" : ""}`}
            title={m.hint}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window.PN, {
  PNCaret, PNChip, PNBtn, PNSwitch, PNSeg, PNSelectChip,
  PNSection, PNField, PNPathRow, PNTestBlock,
  PNHead, PNStrip, PNIndexRow, PNKv,
  PNNavParent, PNNavSub, PNTitlebar,
});
