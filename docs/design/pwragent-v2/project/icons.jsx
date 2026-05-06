/* eslint-disable */
/* PwrAgnt icon set
   - Geometric stroke icons (Lucide-style) at stroke 1.75 (heavier than original 1.5 for legibility)
   - Brand glyphs for platform integrations (Telegram, Discord, Slack, Signal, Mattermost)
   - App glyphs (VS Code "v", Ghostty "G", Vim, Terminal, NeoVim) — flat squares, not photoreal logos
   All icons render at 14–18px; pass size= for adjustment.
*/

const Icon = ({ children, size = 16, stroke = 1.75, className = "", style = {} }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`pa-ico ${className}`}
    style={style}
    aria-hidden="true"
  >
    {children}
  </svg>
);

/* ---------- generic UI icons ---------- */

const Folder = (p) => (
  <Icon {...p}>
    <path d="M3 6.5a2 2 0 0 1 2-2h3.5a2 2 0 0 1 1.5.7l1 1.1a2 2 0 0 0 1.5.7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10.5Z"/>
  </Icon>
);

const Branch = (p) => (
  <Icon {...p}>
    <circle cx="6" cy="5" r="2"/>
    <circle cx="6" cy="19" r="2"/>
    <circle cx="18" cy="7" r="2"/>
    <path d="M6 7v10"/>
    <path d="M18 9c0 5-6 4-6 9"/>
  </Icon>
);

const Worktree = (p) => (
  <Icon {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1.5"/>
    <rect x="3" y="15" width="6" height="6" rx="1.5"/>
    <rect x="15" y="9" width="6" height="6" rx="1.5"/>
    <path d="M9 6h3a3 3 0 0 1 3 3v0"/>
    <path d="M9 18h3a3 3 0 0 0 3-3v0"/>
  </Icon>
);

const Settings = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>
  </Icon>
);

const PlusSquare = (p) => (
  <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/></Icon>
);

const ChevronRight = (p) => <Icon {...p}><path d="M9 6l6 6-6 6"/></Icon>;
const ChevronDown = (p) => <Icon {...p}><path d="M6 9l6 6 6-6"/></Icon>;
const ChevronLeft = (p) => <Icon {...p}><path d="M15 6l-6 6 6 6"/></Icon>;

const Search = (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Icon>;

const Sidebar = (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></Icon>;
const PanelRight = (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></Icon>;

const Plus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>;
const X = (p) => <Icon {...p}><path d="M18 6L6 18M6 6l12 12"/></Icon>;
const Check = (p) => <Icon {...p}><path d="M5 12l5 5 9-11"/></Icon>;
const AlertTriangle = (p) => <Icon {...p}><path d="M12 3l10 18H2L12 3z"/><path d="M12 9v5"/><circle cx="12" cy="18" r="0.5"/></Icon>;
const Info = (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></Icon>;
const HelpCircle = (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 4 2c-1 .8-1.5 1.4-1.5 2.5"/><circle cx="12" cy="17" r="0.5"/></Icon>;
const MoreHorizontal = (p) => <Icon {...p}><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></Icon>;
const Smile = (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M9 14s1 1.5 3 1.5S15 14 15 14"/><circle cx="9" cy="10" r="0.5"/><circle cx="15" cy="10" r="0.5"/></Icon>;
const Power = (p) => <Icon {...p}><path d="M12 3v9"/><path d="M5 8a8 8 0 1 0 14 0"/></Icon>;
const Eye = (p) => <Icon {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></Icon>;
const ArrowLeft = (p) => <Icon {...p}><path d="M19 12H5M12 19l-7-7 7-7"/></Icon>;
const ExternalLink = (p) => <Icon {...p}><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></Icon>;
const Lock = (p) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></Icon>;
const Trash = (p) => <Icon {...p}><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/></Icon>;
const Loader = (p) => <Icon {...p}><path d="M12 3v3"/><path d="M12 18v3"/><path d="M4.93 4.93l2.12 2.12"/><path d="M16.95 16.95l2.12 2.12"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M4.93 19.07l2.12-2.12"/><path d="M16.95 7.05l2.12-2.12"/></Icon>;
const Zap = (p) => <Icon {...p}><path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z"/></Icon>;
const Activity = (p) => <Icon {...p}><path d="M3 12h4l3-9 4 18 3-9h4"/></Icon>;
const Clock = (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>;
const Link = (p) => <Icon {...p}><path d="M10 14a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></Icon>;
const Unlink = (p) => <Icon {...p}><path d="M16 7l4-4"/><path d="M8 17l-4 4"/><path d="M10 14a5 5 0 0 0 7.5.5l3-3"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3"/></Icon>;
const Send = (p) => <Icon {...p}><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></Icon>;
const Inbox = (p) => <Icon {...p}><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3 7v6a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-6l3-7z"/></Icon>;
const Pin = (p) => <Icon {...p}><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7l3 3v2H6v-2l3-3z"/></Icon>;
const Refresh = (p) => <Icon {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></Icon>;
const Play = (p) => <Icon {...p}><path d="M6 4l14 8-14 8V4z"/></Icon>;
const Pause = (p) => <Icon {...p}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></Icon>;
const Download = (p) => <Icon {...p}><path d="M12 3v13M6 11l6 6 6-6M4 21h16"/></Icon>;

/* ---------- platform brand glyphs ----------
   Drawn as filled glyphs sized to type. Color comes from currentColor unless
   we need brand color (Telegram blue, Discord blurple). */

function Telegram({ size = 16, brand = false, className = "", style = {} }) {
  const fill = brand ? "#27a7e7" : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`pa-ico ${className}`} style={style} aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill={fill} />
      <path
        d="M5.6 11.6 17.7 7c.6-.2 1.1.2 1 .8l-2 9.6c-.2.7-.7.9-1.3.5l-3.5-2.6-1.7 1.6c-.2.2-.4.3-.7.2l.3-3.6 6.5-5.9c.3-.3-.1-.4-.4-.2l-8 5L5 11.9c-.6-.2-.6-.6-.1-.8z"
        fill="#fff"
      />
    </svg>
  );
}

function Discord({ size = 16, brand = false, className = "", style = {} }) {
  const fill = brand ? "#5865f2" : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`pa-ico ${className}`} style={style} aria-hidden="true">
      <rect x="1.5" y="3" width="21" height="18" rx="4" fill={fill} />
      <path
        d="M9 9.6c-.6 0-1.1.6-1.1 1.4 0 .7.5 1.4 1.1 1.4s1.1-.6 1.1-1.4c0-.7-.5-1.4-1.1-1.4zm6 0c-.6 0-1.1.6-1.1 1.4 0 .7.5 1.4 1.1 1.4s1.1-.6 1.1-1.4c0-.7-.5-1.4-1.1-1.4z"
        fill="#fff"
      />
      <path
        d="M17.5 6.5c-1-.5-2-.8-3.1-1l-.2.4c1 .2 1.9.5 2.7 1-1-.5-2.2-.8-3.4-.9-.4-.04-.8-.04-1 0-1.2.1-2.4.4-3.4.9.8-.4 1.7-.8 2.7-1l-.2-.4c-1.1.2-2.1.5-3.1 1-1.5 2.4-1.9 4.7-1.7 7 1 1.2 2.4 2 3.9 2.5l.6-.9c-.7-.2-1.4-.5-2-1 .2.1.4.2.5.3 1.7.9 3.6 1 5.4.3.3-.1.6-.3.9-.4 0 0-.4.4-2 1l.6.9c1.5-.5 2.9-1.3 3.9-2.5.2-2.5-.4-4.6-1.7-7z"
        fill="#fff"
      />
    </svg>
  );
}

function Slack({ size = 16, brand = false, className = "", style = {} }) {
  const c1 = brand ? "#36c5f0" : "currentColor";
  const c2 = brand ? "#2eb67d" : "currentColor";
  const c3 = brand ? "#ecb22e" : "currentColor";
  const c4 = brand ? "#e01e5a" : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`pa-ico ${className}`} style={style} aria-hidden="true">
      <rect x="3" y="10" width="6" height="2.5" rx="1.25" fill={c1}/>
      <rect x="11.5" y="3" width="2.5" height="6" rx="1.25" fill={c2}/>
      <rect x="15" y="11.5" width="6" height="2.5" rx="1.25" fill={c3}/>
      <rect x="10" y="15" width="2.5" height="6" rx="1.25" fill={c4}/>
      <rect x="10" y="10" width="4" height="4" rx="1" fill={brand ? "#fff" : "currentColor"} opacity={brand ? 0.9 : 0.5}/>
    </svg>
  );
}

function Signal({ size = 16, brand = false, className = "", style = {} }) {
  const fill = brand ? "#3a76f0" : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`pa-ico ${className}`} style={style} aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill={fill}/>
      <path d="M7 8.5C5.8 9.7 5 11.3 5 13c0 1 .3 2 .8 2.8L4.5 18l3-1.2c.8.5 1.7.7 2.6.7" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
      <circle cx="14.5" cy="11.5" r="3.5" fill="#fff"/>
    </svg>
  );
}

function Mattermost({ size = 16, brand = false, className = "", style = {} }) {
  const fill = brand ? "#0058cc" : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`pa-ico ${className}`} style={style} aria-hidden="true">
      <path d="M12 2c-5 0-9 4.5-9 10 0 4.4 2.6 7.7 6.4 9l.6-3c-2.4-.8-4-3-4-5.8 0-3.4 2.7-6.4 6-6.4s6 3 6 6.4c0 2.8-1.6 5-4 5.8l-.7-3.6h-2L12 22c5 0 9-4.5 9-10S17 2 12 2z" fill={fill}/>
    </svg>
  );
}

/* ---------- app launcher glyphs ---------- */
/* Geometric letter tiles in design-system-styled rounded squares. */

function AppGlyph({ letter, color = "var(--accent)", size = 16 }) {
  return (
    <span
      className="pa-app-glyph"
      style={{
        width: size,
        height: size,
        background: color,
        color: "var(--button-text-on-accent)",
      }}
    >
      {letter}
    </span>
  );
}

const VSCodeGlyph = ({ size = 16 }) => <AppGlyph letter="V" color="#0098ff" size={size} />;
const GhosttyGlyph = ({ size = 16 }) => <AppGlyph letter="G" color="#bf6f4d" size={size} />;
const TerminalGlyph = ({ size = 16 }) => <AppGlyph letter="T" color="#3a3a3a" size={size} />;
const VimGlyph = ({ size = 16 }) => <AppGlyph letter="V" color="#019733" size={size} />;
const NeoVimGlyph = ({ size = 16 }) => <AppGlyph letter="N" color="#019733" size={size} />;
const CursorGlyph = ({ size = 16 }) => <AppGlyph letter="C" color="#171717" size={size} />;
const ZedGlyph = ({ size = 16 }) => <AppGlyph letter="Z" color="#0d3a82" size={size} />;

/* ---------- brand logo ---------- */

function PwrAgntLogo({ size = 22, withText = true }) {
  return (
    <span className="pa-brandlogo" style={{ height: size }}>
      <span className="pa-brandlogo__mark" style={{ width: size, height: size }}>
        {/* PwrAgnt mark — stacked transcript bars on dark tile */}
        <svg viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
          <rect x="0" y="0" width="128" height="128" rx="28"
                fill="#0a0908" stroke="rgba(232,116,58,0.2)" strokeWidth="2" />
          <g fill="var(--accent)" transform="translate(0, 4)">
            <rect x="28" y="32" width="60" height="10" rx="2"/>
            <rect x="28" y="50" width="72" height="10" rx="2" opacity="0.65"/>
            <rect x="28" y="68" width="44" height="10" rx="2" opacity="0.4"/>
            <rect x="28" y="86" width="56" height="10" rx="2" opacity="0.25"/>
          </g>
        </svg>
      </span>
      {withText && (
        <span className="pa-brandlogo__word">
          Pwr<span className="pa-brandlogo__word-accent">Agent</span>
        </span>
      )}
    </span>
  );
}

window.PA = window.PA || {};
window.PA.Icon = {
  Folder, Branch, Worktree, Settings, PlusSquare, ChevronRight, ChevronDown, ChevronLeft,
  Search, Sidebar, PanelRight, Plus, X, Check, AlertTriangle, Info, HelpCircle, MoreHorizontal,
  Smile, Power, Eye, ArrowLeft, ExternalLink, Lock, Trash, Loader, Zap, Activity, Clock, Link, Unlink,
  Send, Inbox, Pin, Refresh, Play, Pause, Download,
  // platform
  Telegram, Discord, Slack, Signal, Mattermost,
  // app glyphs
  VSCodeGlyph, GhosttyGlyph, TerminalGlyph, VimGlyph, NeoVimGlyph, CursorGlyph, ZedGlyph,
  // logo
  PwrAgntLogo,
};
