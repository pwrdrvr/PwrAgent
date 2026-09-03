/* eslint-disable */
/* Provider-nav prototype — screens, routing, and the three
   navigation models under comparison:
     hub  — parent = defaults + provider index; sub-items are focused screens (recommended)
     jump — parent = one long page; sub-items jump-scroll with scroll-spy
     solo — parent = one long page; sub-items isolate a single section */
const { useState, useRef, useEffect, useMemo } = React;
const {
  PNChip, PNBtn, PNSwitch, PNSeg, PNSelectChip,
  PNSection, PNField, PNPathRow, PNTestBlock,
  PNHead, PNStrip, PNIndexRow, PNKv,
  PNNavParent, PNNavSub, PNTitlebar,
} = window.PN;

const MODES = [
  { id: "hub", label: "A · hub", hint: "Parent shows defaults + provider index; each provider is its own screen" },
  { id: "jump", label: "B · jump", hint: "One long page; sub-items jump-scroll and track your position" },
  { id: "solo", label: "C · solo", hint: "One long page; sub-items isolate a single provider" },
];

/* Provider order matches the shipped reorder: Gemini CLI sorts last
   (Google withdrew access for regular accounts). */
const PROVIDERS = [
  { id: "codex", label: "Codex", glyph: "C", dot: "ok",
    meta: "6 models · /opt/homebrew/bin/codex",
    chips: [{ label: "config" }, { label: "0.146.0" }, { label: "Using", kind: "ok" }],
    chip: "config" },
  { id: "kimi", label: "Kimi Code CLI", glyph: "K", dot: "ok",
    meta: "2 models · /opt/homebrew/bin/kimi",
    chips: [{ label: "1.4.2" }, { label: "Available" }],
    chip: "1.4.2" },
  { id: "grok", label: "Grok", glyph: "X", dot: "ok",
    meta: "3 models · managed PwrAgent build",
    chips: [{ label: "managed" }, { label: "1.9.0" }],
    chip: "managed" },
  { id: "qwen", label: "Qwen Code", glyph: "Q", dot: "idle",
    meta: "Not installed",
    chips: [{ label: "not installed" }],
    chip: "not installed" },
  { id: "gemini", label: "Gemini CLI", glyph: "G", dot: "off",
    meta: "Requires a paid Google plan",
    chips: [{ label: "Disabled" }],
    chip: "Disabled", off: true },
];

const PLATFORMS = [
  { id: "telegram", label: "Telegram", icon: "Telegram", dot: "ok",
    meta: "@pwragent_bot · api.telegram.org", chip: "Connected", chipKind: "ok" },
  { id: "discord", label: "Discord", icon: "Discord", dot: "ok",
    meta: "PwrAgent#4421 · discord.com/api", chip: "Connected", chipKind: "ok" },
  { id: "mattermost", label: "Mattermost", icon: "Mattermost", dot: "idle",
    meta: "Not configured", chip: "Idle" },
  { id: "slack", label: "Slack", icon: "Slack", dot: "warn",
    meta: "Suspended after rate limits", chip: "Suspended", chipKind: "warn" },
  { id: "feishu", label: "Feishu / Lark", glyph: "F", dot: "idle",
    meta: "Not configured", chip: "Idle" },
  { id: "line", label: "LINE", glyph: "L", dot: "idle",
    meta: "Not configured", chip: "Idle" },
];

const NAV_ITEMS = [
  { id: "general", label: "General" },
  { id: "applications", label: "Applications" },
  { id: "plugins", label: "Plugins",
    children: [{ id: "mcps", label: "MCPs" }] },
  { id: "profiles", label: "Profiles" },
  { id: "models", label: "AI Providers",
    children: PROVIDERS.map((p) => ({ id: p.id, label: p.label, dot: p.dot, chip: p.off ? "off" : undefined })) },
  { id: "pricing", label: "Usage & Pricing" },
  { id: "messaging", label: "Messaging",
    children: PLATFORMS.map((p) => ({ id: p.id, label: p.label, dot: p.dot })) },
  { id: "federation", label: "Federation" },
  { id: "divider" },
  { id: "access", label: "Access Control" },
  { id: "git", label: "Git" },
  { id: "worktrees", label: "Worktrees" },
  { id: "threads", label: "Thread Management" },
  { id: "archived", label: "Archived Threads" },
  { id: "experimental", label: "Experimental" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "about", label: "About" },
];
const NAV_BY_ID = Object.fromEntries(NAV_ITEMS.filter((i) => i.id !== "divider").map((i) => [i.id, i]));

/* ---------------- provider field groups ---------------- */

function CodexFields() {
  const [test, setTest] = useState("idle");
  return (
    <>
      <PNField label="Codex path" sub="Absolute path to the Codex binary. Leave blank to use auto discovery." tags={["config"]}>
        <input className="pn-input" defaultValue="/opt/homebrew/bin/codex" />
        <div className="pn-row">
          <PNBtn disabled>Save path</PNBtn>
          <PNBtn>Use auto discovery</PNBtn>
        </div>
      </PNField>
      <PNField label="Available paths" sub="Detected on this machine. The newest supported version is used automatically." tags={["config"]}>
        <div className="pn-paths">
          <PNPathRow selected path="/opt/homebrew/bin/codex"
            chips={[{ label: "config" }, { label: "0.146.0" }, { label: "Using", kind: "ok" }]} />
          <PNPathRow path="/Applications/ChatGPT.app/Contents/Resources/codex"
            chips={[{ label: "application" }, { label: "0.150.0-alpha.8" }, { label: "Available" }]} action="Use" />
          <PNPathRow path="/opt/homebrew/bin/codex"
            chips={[{ label: "application" }, { label: "0.146.0" }, { label: "Available" }]} action="Use" />
        </div>
      </PNField>
      <PNField label="Auth profile" sub="Select the Codex home used for auth, config, sessions, skills, and state on the next app launch." tags={["config"]}>
        <div className="pn-row"><PNBtn>Create Codex profile</PNBtn></div>
        <div className="pn-paths">
          <PNPathRow title="System default" note="huntharo@gmail.com" path="/Users/huntharo/.codex"
            chips={[{ label: "default" }, { label: "auth" }, { label: "config" }]} action="Use" />
          <PNPathRow title="dev" note="huntharo@gmail.com" path="/Users/huntharo/.codex/profiles/dev"
            chips={[{ label: "profile" }, { label: "auth" }]} action="Use" />
          <PNPathRow selected title="work" note="harold@example.com" path="/Users/huntharo/.codex/profiles/work"
            chips={[{ label: "profile" }, { label: "auth" }, { label: "config" }, { label: "Next launch", kind: "ok" }]} />
        </div>
      </PNField>
      <PNField label="Connection test" sub="Spawns the selected Codex binary with --version and validates the version banner.">
        <PNTestBlock glyph="C" name="/opt/homebrew/bin/codex" sub="spawn --version" status={test}
          onTest={() => { setTest("testing"); setTimeout(() => setTest("ok"), 900); }} />
      </PNField>
    </>
  );
}

function KimiFields() {
  const [test, setTest] = useState("ok");
  return (
    <>
      <PNField label="Enabled" sub="Show this agent in the model picker.">
        <PNSwitch on onChange={() => {}} />
      </PNField>
      <PNField label="CLI path" sub="Leave blank to use auto discovery." tags={["config"]}>
        <input className="pn-input pn-input--inline" defaultValue="/opt/homebrew/bin/kimi" />
      </PNField>
      <PNField label="Connection test" sub="Spawns kimi --version.">
        <PNTestBlock glyph="K" name="kimi --version" sub="1.4.2" status={test}
          onTest={() => { setTest("testing"); setTimeout(() => setTest("ok"), 900); }} />
      </PNField>
    </>
  );
}

function GrokFields() {
  const [managed, setManaged] = useState(true);
  const [test, setTest] = useState("ok");
  return (
    <>
      <PNField label="Enabled" sub="Show this agent in the model picker.">
        <PNSwitch on onChange={() => {}} />
      </PNField>
      <PNField label="Managed PwrAgent builds" sub="Download and prefer the PwrAgent Grok fork build.">
        <PNSwitch on={managed} onChange={setManaged} />
      </PNField>
      <PNField label="Connection test" sub="Spawns grok --acp and validates the handshake.">
        <PNTestBlock glyph="X" name="grok --acp" sub="1.9.0 · managed build" status={test}
          onTest={() => { setTest("testing"); setTimeout(() => setTest("ok"), 900); }} />
      </PNField>
    </>
  );
}

function QwenFields() {
  return (
    <>
      <PNField label="Enabled" sub="Show this agent in the model picker.">
        <PNSwitch on onChange={() => {}} />
      </PNField>
      <PNField label="Install" sub="Qwen Code was not found on this machine.">
        <div className="pn-row">
          <input className="pn-input pn-input--inline" readOnly defaultValue="npm install -g @qwen-code/qwen-code" />
          <PNBtn>Copy</PNBtn>
        </div>
      </PNField>
    </>
  );
}

function GeminiFields() {
  const [enabled, setEnabled] = useState(false);
  return (
    <>
      <PNField label="Enabled" sub="Show this agent in the model picker.">
        <PNSwitch on={enabled} onChange={setEnabled} />
      </PNField>
      <PNField label="Access" sub="Why this provider sorts last.">
        <p className="pn-notice pn-notice--warn">
          Google withdrew Gemini CLI agent access for regular accounts. A paid Google AI plan is required to connect.
        </p>
      </PNField>
      <PNField label="CLI path" sub="Leave blank to use auto discovery." tags={["config"]}>
        <input className="pn-input pn-input--inline" placeholder="gemini" />
      </PNField>
    </>
  );
}

const PROVIDER_SECTIONS = [
  { id: "codex", title: "Codex", Fields: CodexFields },
  { id: "kimi", title: "Kimi Code CLI", Fields: KimiFields },
  { id: "grok", title: "Grok", Fields: GrokFields },
  { id: "qwen", title: "Qwen Code", Fields: QwenFields },
  { id: "gemini", title: "Gemini CLI", Fields: GeminiFields },
];

/* ---------------- messaging field groups ---------------- */

function MessagingGeneralFields() {
  const [notif, setNotif] = useState("Some");
  return (
    <>
      <PNField label="Tool usage notifications" sub="How chatty bridged messages are while the agent runs tools."
        help="Affects all platforms. Tweak per-thread from the thread's context panel.">
        <PNSeg options={["None", "Less", "Some", "More", "All"]} value={notif} onChange={setNotif} />
      </PNField>
      <PNField label="Input debounce" sub="Wait for split text, code blocks, images, or files before starting one agent turn."
        help="Use 0 to disable the pre-start wait. Recommended: 500ms.">
        <div className="pn-row">
          <input className="pn-input pn-input--short" defaultValue="500" />
          <span style={{ font: "500 11px/1 var(--font-mono)", color: "var(--text-muted)" }}>ms</span>
        </div>
      </PNField>
    </>
  );
}

function TokenField() {
  return (
    <PNField label="Bot token" sub="Stored in the system keychain.">
      <div className="pn-row">
        <input className="pn-input pn-input--inline" type="password" defaultValue="•••••••••••••" />
        <PNBtn>Replace</PNBtn>
        <PNBtn>Clear</PNBtn>
      </div>
    </PNField>
  );
}

function TelegramFields() {
  const I = window.PA.Icon;
  const [test, setTest] = useState("ok");
  return (
    <>
      <PNField label="Enabled" sub="Turn the Telegram adapter on or off independently of the global messaging switch.">
        <PNSwitch on onChange={() => {}} />
      </PNField>
      <TokenField />
      <PNField label="Connection test" sub="Pings getMe on the Telegram Bot API.">
        <PNTestBlock glyph={<I.Telegram size={16} brand />} name="@pwragent_bot" sub="api.telegram.org · last test 2m ago" status={test}
          onTest={() => { setTest("testing"); setTimeout(() => setTest("ok"), 900); }} />
      </PNField>
      <PNField label="Streaming responses" sub="Send partial assistant tokens as Telegram message edits."
        help="Disable on slow networks or shared chats to reduce edit-rate.">
        <PNSwitch on onChange={() => {}} />
      </PNField>
      <PNField label="Authorized user IDs" sub="Comma-separated Telegram user IDs that can DM the bot.">
        <input className="pn-input pn-input--inline" defaultValue="8460800771" />
      </PNField>
    </>
  );
}

function DiscordFields() {
  const I = window.PA.Icon;
  const [test, setTest] = useState("ok");
  return (
    <>
      <PNField label="Enabled">
        <PNSwitch on onChange={() => {}} />
      </PNField>
      <TokenField />
      <PNField label="Connection test" sub="Validates the token via /users/@me on the Discord API.">
        <PNTestBlock glyph={<I.Discord size={16} brand />} name="PwrAgent#4421" sub="discord.com/api · last test 14m ago" status={test}
          onTest={() => { setTest("testing"); setTimeout(() => setTest("ok"), 900); }} />
      </PNField>
    </>
  );
}

function MattermostFields() {
  return (
    <>
      <PNField label="Enabled"><PNSwitch onChange={() => {}} /></PNField>
      <PNField label="Server URL" sub="Base URL of your Mattermost instance.">
        <input className="pn-input pn-input--inline" placeholder="https://chat.example.com" />
      </PNField>
      <TokenField />
    </>
  );
}

function SlackFields() {
  return (
    <>
      <PNField label="Enabled"><PNSwitch on onChange={() => {}} /></PNField>
      <PNField label="Status" sub="Adapter health.">
        <p className="pn-notice pn-notice--warn">Suspended after repeated 429s. Resume from the Activity window.</p>
      </PNField>
      <TokenField />
    </>
  );
}

function FeishuFields() {
  return (
    <>
      <PNField label="Enabled"><PNSwitch onChange={() => {}} /></PNField>
      <PNField label="App credentials" sub="App ID and secret from the Feishu developer console.">
        <div className="pn-row">
          <input className="pn-input pn-input--inline" placeholder="cli_a1…" />
          <input className="pn-input pn-input--inline" type="password" placeholder="App secret" />
        </div>
      </PNField>
    </>
  );
}

function LineFields() {
  return (
    <>
      <PNField label="Enabled"><PNSwitch onChange={() => {}} /></PNField>
      <PNField label="Channel access token" sub="Stored in the system keychain.">
        <input className="pn-input pn-input--inline" type="password" placeholder="Not set" />
      </PNField>
    </>
  );
}

const PLATFORM_SECTIONS = [
  { id: "telegram", title: "Telegram", Fields: TelegramFields },
  { id: "discord", title: "Discord", Fields: DiscordFields },
  { id: "mattermost", title: "Mattermost", Fields: MattermostFields },
  { id: "slack", title: "Slack", Fields: SlackFields },
  { id: "feishu", title: "Feishu / Lark", Fields: FeishuFields },
  { id: "line", title: "LINE", Fields: LineFields },
];

/* ---------------- plugins field groups ---------------- */

function PluginListFields() {
  return (
    <PNField label="Installed plugins" sub="Skills and commands available to agents in this profile.">
      <div className="pn-paths">
        <PNPathRow title="desktop-e2e-fixture-seeding" path=".agents/skills/desktop-e2e-fixture-seeding"
          chips={[{ label: "skill" }, { label: "enabled", kind: "ok" }]} />
        <PNPathRow title="release-runbook" path=".agents/skills/release-runbook"
          chips={[{ label: "skill" }, { label: "enabled", kind: "ok" }]} />
      </div>
    </PNField>
  );
}

function McpFields() {
  return (
    <>
      <PNField label="MCP servers" sub="Model Context Protocol servers exposed to agents.">
        <div className="pn-paths">
          <PNPathRow title="github" path="npx @modelcontextprotocol/server-github"
            chips={[{ label: "stdio" }, { label: "Connected", kind: "ok" }]} />
          <PNPathRow title="playwright" path="npx @playwright/mcp"
            chips={[{ label: "stdio" }, { label: "Connected", kind: "ok" }]} />
          <PNPathRow title="postgres" path="npx @modelcontextprotocol/server-postgres"
            chips={[{ label: "stdio" }, { label: "Error", kind: "err" }]} action="Retry" />
        </div>
        <div className="pn-row"><PNBtn>Add server</PNBtn></div>
      </PNField>
    </>
  );
}

const PLUGIN_SECTIONS = [
  { id: "plugin-list", title: "Plugins", Fields: PluginListFields },
  { id: "mcps", title: "MCPs", Fields: McpFields },
];

/* ---------------- defaults section ---------------- */

function DefaultsFields() {
  const [fast, setFast] = useState(true);
  return (
    <>
      <PNField label="OpenAI" sub="6 discovered models">
        <div className="pn-row">
          <PNSelectChip>GPT-5.6-Terra</PNSelectChip>
          <PNSelectChip>xhigh</PNSelectChip>
        </div>
        <div className="pn-row">
          <PNBtn>Apply to launchpads</PNBtn>
          <PNBtn>Schedule existing threads…</PNBtn>
          <PNBtn kind="ghost">Reset</PNBtn>
        </div>
      </PNField>
      <PNField label="Fast mode" sub="Allowed for this profile. Existing threads keep their own choice.">
        <div className="pn-row">
          <PNSwitch on={fast} onChange={setFast} />
          <PNBtn>Turn off everywhere</PNBtn>
        </div>
      </PNField>
      <PNField label="Model catalog" sub="Refresh after installing or upgrading a provider CLI.">
        <PNBtn kind="ghost" wide>Refresh models</PNBtn>
      </PNField>
    </>
  );
}

/* ---------------- stub screens ---------------- */

const STUBS = {
  general: { eyebrow: "General", title: "General", help: "Profile-wide behavior.",
    body: (
      <>
        <PNField label="Promote finished turns" sub="Move a finished turn to the top of Attention for review.">
          <PNSwitch on onChange={() => {}} />
        </PNField>
        <PNField label="Launch at login"><PNSwitch onChange={() => {}} /></PNField>
      </>
    ) },
  applications: { eyebrow: "Applications", title: "Editor & terminal", help: "Apps PwrAgent opens from the composer launchers.",
    body: (
      <PNField label="Default editor" sub="Detected on this machine.">
        <div className="pn-paths">
          <PNPathRow selected title="VS Code" path="/Applications/Visual Studio Code.app" chips={[{ label: "Selected", kind: "ok" }]} />
          <PNPathRow title="Zed" path="/Applications/Zed.app" action="Use" />
        </div>
      </PNField>
    ) },
  profiles: { eyebrow: "Profiles", title: "Profiles", help: "Isolated configuration and state under ~/.pwragent/profiles.",
    body: (
      <PNField label="Active profile" sub="Restart applies a profile switch.">
        <div className="pn-paths">
          <PNPathRow selected title="default" path="~/.pwragent/profiles/default" chips={[{ label: "active", kind: "ok" }]} />
          <PNPathRow title="dev" path="~/.pwragent/profiles/dev" action="Use" />
        </div>
      </PNField>
    ) },
  pricing: { eyebrow: "Usage", title: "Usage & pricing", help: "Token spend for the current period.",
    body: <PNKv rows={[["This week", "$41.28"], ["GPT-5.6-Terra", "$32.10"], ["grok-4", "$9.18"]]} /> },
  federation: { eyebrow: "Federation", title: "Peers", help: "Other PwrAgent instances sharing this profile.",
    body: (
      <PNField label="Peers" sub="Lease holder runs messaging bridges.">
        <div className="pn-paths">
          <PNPathRow title="mac-studio.local" path="lease holder · last seen now" chips={[{ label: "lease", kind: "ok" }]} />
          <PNPathRow title="macbook-pro.local" path="idle · last seen 3m ago" chips={[{ label: "peer" }]} />
        </div>
      </PNField>
    ) },
  access: { eyebrow: "Access Control", title: "Roles", help: "Messaging RBAC roles and grants.",
    body: (
      <PNField label="Built-in roles">
        <div className="pn-paths">
          <PNPathRow title="Owner" path="full control · 1 member" chips={[{ label: "built-in" }]} />
          <PNPathRow title="Reviewer" path="read + reply · 2 members" chips={[{ label: "built-in" }]} />
        </div>
      </PNField>
    ) },
  git: { eyebrow: "Git", title: "Git", help: "Branching and commit behavior for agent runs.",
    body: (
      <PNField label="Branch naming" sub="Pattern for agent-created branches.">
        <input className="pn-input pn-input--inline" defaultValue="claude/{slug}-{hash}" />
      </PNField>
    ) },
  worktrees: { eyebrow: "Worktrees", title: "Storage & cleanup", help: "Every thread gets a fresh worktree so concurrent agents don't collide.",
    body: (
      <PNField label="Storage location" sub="Where worktrees live on disk.">
        <PNSeg options={["In repository", "User home"]} value="User home" onChange={() => {}} />
      </PNField>
    ) },
  threads: { eyebrow: "Threads", title: "Thread management", help: "Lifecycle rules for threads in this profile.",
    body: (
      <PNField label="Auto-archive" sub="Archive threads with no activity.">
        <PNSeg options={["Never", "After 30 days", "After 90 days"]} value="After 30 days" onChange={() => {}} />
      </PNField>
    ) },
  archived: { eyebrow: "Threads", title: "Archived threads", help: "Threads removed from every lens. Restore returns them to Inbox.",
    body: <PNKv rows={[["Archived", "128 threads"], ["On disk", "412 MB"]]} /> },
  experimental: { eyebrow: "Experimental", title: "Experimental features", help: "Opt-in features that may change shape or be removed.",
    body: (
      <PNField label="Diff eliding" sub="Compress unchanged hunks of large diffs before sending them to the agent.">
        <PNSwitch on onChange={() => {}} />
      </PNField>
    ) },
  troubleshooting: { eyebrow: "Support", title: "Troubleshooting", help: "Logs and diagnostics.",
    body: (
      <PNField label="Main process log" sub="Rotates daily.">
        <div className="pn-row">
          <input className="pn-input pn-input--inline" readOnly defaultValue="~/.pwragent/logs/main.log" />
          <PNBtn>Open</PNBtn>
        </div>
      </PNField>
    ) },
  about: { eyebrow: "About", title: "PwrAgent", help: "Thread-centric coding agent. Built by PwrDrvr LLC.",
    body: <PNKv rows={[["Version", "1.0.0-alpha.3"], ["Electron", "41.2.1"], ["Node", "24.14.1"]]} /> },
};

/* ---------------- app ---------------- */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "mode": "hub"
}/*EDITMODE-END*/;

const DEFAULTS_STRIP_CHIPS = ["OpenAI · GPT-5.6-Terra", "xhigh", "Fast mode on"];
const GENERAL_STRIP_CHIPS = ["notifications Some", "debounce 500ms"];

function App() {
  const I = window.PA.Icon;
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const mode = tweaks.mode || "hub";

  const [route, setRoute] = useState({ section: "models", sub: null });
  const [openGroups, setOpenGroups] = useState({ models: true });
  const [collapsed, setCollapsed] = useState({ gemini: true });
  const [spy, setSpy] = useState(null);

  const contentRef = useRef(null);
  const sectionRefs = useRef({});
  const pendingScrollRef = useRef(null);

  const groupSections = (sectionId) =>
    sectionId === "models" ? PROVIDER_SECTIONS
    : sectionId === "messaging" ? PLATFORM_SECTIONS
    : sectionId === "plugins" ? PLUGIN_SECTIONS
    : [];

  const scrollToSub = (subId) => {
    setCollapsed((c) => ({ ...c, [subId]: false }));
    requestAnimationFrame(() => {
      const el = sectionRefs.current[subId];
      const cont = contentRef.current;
      if (el && cont) cont.scrollTo({ top: Math.max(el.offsetTop - 12, 0), behavior: "smooth" });
    });
  };

  useEffect(() => {
    if (pendingScrollRef.current && mode === "jump") {
      const id = pendingScrollRef.current;
      pendingScrollRef.current = null;
      scrollToSub(id);
    }
  });

  const openParent = (id) => {
    setRoute({ section: id, sub: null });
    setSpy(null);
    if (NAV_BY_ID[id] && NAV_BY_ID[id].children) {
      setOpenGroups((g) => ({ ...g, [id]: true }));
    }
    const cont = contentRef.current;
    if (cont) cont.scrollTo({ top: 0 });
  };

  const openSub = (parentId, subId) => {
    setOpenGroups((g) => ({ ...g, [parentId]: true }));
    if (mode === "jump") {
      if (route.section !== parentId) {
        setRoute({ section: parentId, sub: null });
        pendingScrollRef.current = subId;
      } else {
        scrollToSub(subId);
      }
    } else {
      setRoute({ section: parentId, sub: subId });
      setSpy(null);
      const cont = contentRef.current;
      if (cont) cont.scrollTo({ top: 0 });
    }
  };

  const applyMode = (m) => {
    if (m === mode) return;
    if (m === "jump" && route.sub) {
      pendingScrollRef.current = route.sub;
      setRoute({ section: route.section, sub: null });
    }
    if (mode === "jump" && m !== "jump" && spy) {
      setRoute({ section: route.section, sub: spy });
    }
    setSpy(null);
    setTweak("mode", m);
  };

  const onScroll = () => {
    if (mode !== "jump") return;
    const ids = groupSections(route.section).map((s) => s.id);
    const cont = contentRef.current;
    if (!cont || !ids.length) return;
    let active = null;
    for (const id of ids) {
      const el = sectionRefs.current[id];
      if (el && el.offsetTop - 120 <= cont.scrollTop) active = id;
    }
    /* The last section can never reach the top of the scroll container,
       so at the bottom of the scroll it owns the active state. */
    if (cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 4) {
      active = ids[ids.length - 1];
    }
    setSpy(active);
  };

  const collapseAllIn = (sections, value) =>
    setCollapsed((c) => {
      const next = { ...c };
      sections.forEach((s) => { next[s.id] = value; });
      return next;
    });

  /* ---- render helpers ---- */

  const renderSections = (sections, eyebrow) =>
    sections.map((s) => (
      <PNSection
        key={s.id}
        id={`pn-sec-${s.id}`}
        refFn={(el) => { sectionRefs.current[s.id] = el; }}
        eyebrow={eyebrow}
        title={s.title}
        chip={(PROVIDERS.find((p) => p.id === s.id) || PLATFORMS.find((p) => p.id === s.id) || {}).chip}
        chipKind={(PLATFORMS.find((p) => p.id === s.id) || {}).chipKind}
        collapsed={!!collapsed[s.id]}
        onToggle={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}
      >
        <s.Fields />
      </PNSection>
    ));

  const bulkControls = (sections) => (
    <>
      <PNBtn sm kind="ghost" onClick={() => collapseAllIn(sections, true)}>Collapse all</PNBtn>
      <PNBtn sm kind="ghost" onClick={() => collapseAllIn(sections, false)}>Expand all</PNBtn>
    </>
  );

  const providersHead = (withControls) => (
    <PNHead eyebrow="Models" title="AI providers"
      help="Choose profile-wide model baselines, inspect discovered models, and configure provider credentials."
      actions={withControls ? bulkControls(PROVIDER_SECTIONS) : null} />
  );

  const defaultsSection = (
    <PNSection
      id="pn-sec-defaults"
      eyebrow="Defaults"
      title="New thread defaults"
      desc="These profile-wide baselines fill new launchpads that do not already have a directory or learned provider choice."
      collapsed={!!collapsed.defaults}
      onToggle={() => setCollapsed((c) => ({ ...c, defaults: !c.defaults }))}
    >
      <DefaultsFields />
    </PNSection>
  );

  let screen = null;
  let screenLabel = NAV_BY_ID[route.section] ? NAV_BY_ID[route.section].label : route.section;
  let crumbs = [{ label: screenLabel }];

  if (route.section === "models") {
    const focused = route.sub && mode !== "jump"
      ? PROVIDER_SECTIONS.find((s) => s.id === route.sub)
      : null;
    if (focused) {
      const p = PROVIDERS.find((x) => x.id === focused.id) || {};
      crumbs = [
        { label: "AI Providers", onClick: () => openParent("models") },
        { label: focused.title },
      ];
      screenLabel = `AI Providers · ${focused.title}`;
      screen = (
        <>
          <PNHead eyebrow="Models" title={focused.title}
            actions={p.chip ? <PNChip kind={p.id === "codex" ? undefined : p.chipKind}>{p.chip}</PNChip> : null} />
          <PNStrip eyebrow="Defaults" label="New thread defaults" chips={DEFAULTS_STRIP_CHIPS}
            actionLabel="Edit defaults" onAction={() => openParent("models")} />
          <PNSection headerless title={focused.title}><focused.Fields /></PNSection>
        </>
      );
    } else if (mode === "hub") {
      screen = (
        <>
          {providersHead(false)}
          {defaultsSection}
          <PNSection id="pn-sec-index" eyebrow="Providers" title="Configured providers"
            desc="Open a provider to manage its binary, credentials, and connection."
            collapsed={false} onToggle={() => {}}>
            <div className="pn-index">
              {PROVIDERS.map((p) => (
                <PNIndexRow key={p.id} glyph={p.glyph} name={p.label} meta={p.meta}
                  chips={p.chips} off={p.off} onOpen={() => openSub("models", p.id)} />
              ))}
            </div>
          </PNSection>
        </>
      );
    } else {
      screen = (
        <>
          {providersHead(true)}
          {defaultsSection}
          {renderSections(PROVIDER_SECTIONS, "Models")}
        </>
      );
    }
  } else if (route.section === "messaging") {
    const focused = route.sub && mode !== "jump"
      ? PLATFORM_SECTIONS.find((s) => s.id === route.sub)
      : null;
    const generalSection = (
      <PNSection id="pn-sec-msg-general" eyebrow="Messaging" title="General" chip="default"
        collapsed={!!collapsed["msg-general"]}
        onToggle={() => setCollapsed((c) => ({ ...c, "msg-general": !c["msg-general"] }))}>
        <MessagingGeneralFields />
      </PNSection>
    );
    if (focused) {
      const p = PLATFORMS.find((x) => x.id === focused.id) || {};
      crumbs = [
        { label: "Messaging", onClick: () => openParent("messaging") },
        { label: focused.title },
      ];
      screenLabel = `Messaging · ${focused.title}`;
      screen = (
        <>
          <PNHead eyebrow="Messaging" title={focused.title}
            actions={p.chip ? <PNChip kind={p.chipKind}>{p.chip}</PNChip> : null} />
          <PNStrip eyebrow="Messaging" label="General" chips={GENERAL_STRIP_CHIPS}
            actionLabel="Edit general" onAction={() => openParent("messaging")} />
          <PNSection headerless title={focused.title}><focused.Fields /></PNSection>
        </>
      );
    } else if (mode === "hub") {
      screen = (
        <>
          <PNHead eyebrow="Messaging" title="Connected chat platforms"
            help="Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone. Tokens are stored in the system keychain." />
          {generalSection}
          <PNSection id="pn-sec-msg-index" eyebrow="Platforms" title="Configured platforms"
            desc="Open a platform to manage its credentials and connection."
            collapsed={false} onToggle={() => {}}>
            <div className="pn-index">
              {PLATFORMS.map((p) => (
                <PNIndexRow key={p.id}
                  glyph={p.icon ? React.createElement(I[p.icon], { size: 14, brand: true }) : p.glyph}
                  name={p.label} meta={p.meta}
                  chips={p.chip ? [{ label: p.chip, kind: p.chipKind }] : []}
                  off={p.dot === "idle"}
                  onOpen={() => openSub("messaging", p.id)} />
              ))}
            </div>
          </PNSection>
        </>
      );
    } else {
      screen = (
        <>
          <PNHead eyebrow="Messaging" title="Connected chat platforms"
            help="Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone."
            actions={bulkControls(PLATFORM_SECTIONS)} />
          {generalSection}
          {renderSections(PLATFORM_SECTIONS, "Messaging")}
        </>
      );
    }
  } else if (route.section === "plugins") {
    const focused = route.sub && mode !== "jump"
      ? PLUGIN_SECTIONS.find((s) => s.id === route.sub)
      : null;
    if (focused) {
      crumbs = [
        { label: "Plugins", onClick: () => openParent("plugins") },
        { label: focused.title },
      ];
      screenLabel = `Plugins · ${focused.title}`;
      screen = (
        <>
          <PNHead eyebrow="Plugins" title={focused.title} />
          <PNSection headerless title={focused.title}><focused.Fields /></PNSection>
        </>
      );
    } else {
      screen = (
        <>
          <PNHead eyebrow="Plugins" title="Plugins"
            help="Skills, commands, and MCP servers available to agents in this profile." />
          {renderSections(PLUGIN_SECTIONS, "Plugins")}
        </>
      );
    }
  } else {
    const stub = STUBS[route.section] || { eyebrow: "Settings", title: screenLabel };
    screen = (
      <>
        <PNHead eyebrow={stub.eyebrow} title={stub.title} help={stub.help} />
        {stub.body && (
          <section className="pn-panel"><div className="pn-fields">{stub.body}</div></section>
        )}
      </>
    );
  }

  /* ---- nav active states ---- */
  const subActive = (parentId, subId) =>
    route.section === parentId
    && (mode === "jump" ? spy === subId : route.sub === subId);
  const parentActive = (item) => {
    if (route.section !== item.id) return false;
    if (!item.children) return true;
    const anySub = item.children.some((c) => subActive(item.id, c.id));
    return !anySub;
  };

  return (
    <div className="pn-window" data-screen-label={screenLabel}>
      <div className="pn-traffic" aria-hidden="true"><span /><span /><span /></div>
      <nav className="pn-nav" aria-label="Settings sections">
        <div className="pn-nav__masthead">
          <p className="pn-nav__brand">Pwr<span className="pn-nav__brand-accent">Agent</span></p>
        </div>
        <button type="button" className="pn-nav__exit"><I.ArrowLeft size={13} /> Exit Settings</button>
        <div className="pn-nav__group-label">General</div>
        {NAV_ITEMS.map((item, i) =>
          item.id === "divider" ? (
            <hr key={`divider-${i}`} className="pn-nav__divider" />
          ) : (
            <PNNavParent
              key={item.id}
              item={item}
              active={parentActive(item)}
              open={!!openGroups[item.id]}
              onOpenToggle={(id) => setOpenGroups((g) => ({ ...g, [id]: !g[id] }))}
              onNavigate={openParent}
            >
              {(item.children || []).map((sub) => (
                <PNNavSub key={sub.id} sub={sub}
                  active={subActive(item.id, sub.id)}
                  onClick={() => openSub(item.id, sub.id)} />
              ))}
            </PNNavParent>
          )
        )}
      </nav>

      <div className="pn-main">
        <PNTitlebar crumbs={crumbs} mode={mode} setMode={applyMode} modes={MODES} />
        <div className="pn-content" ref={contentRef} onScroll={onScroll}>
          <div className="pn-stack">{screen}</div>
        </div>
      </div>

      <window.TweaksPanel>
        <window.TweakSection label="Navigation model" />
        <window.TweakRadio label="Mode" value={mode} onChange={applyMode}
          options={["hub", "jump", "solo"]} />
        <window.TweakSection label="Jump to" />
        <window.TweakButton label="AI Providers" onClick={() => openParent("models")} />
        <window.TweakButton label="AI Providers · Codex" onClick={() => openSub("models", "codex")} />
        <window.TweakButton label="AI Providers · Gemini CLI" onClick={() => openSub("models", "gemini")} />
        <window.TweakButton label="Messaging" onClick={() => openParent("messaging")} />
        <window.TweakButton label="Messaging · Telegram" onClick={() => openSub("messaging", "telegram")} />
        <window.TweakButton label="Plugins · MCPs" onClick={() => openSub("plugins", "mcps")} />
      </window.TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
