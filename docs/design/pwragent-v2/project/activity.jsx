/* eslint-disable */
const { useState: useStateAct } = React;

function ActivityRow({ entry }) {
  const I = window.PA.Icon;
  const Glyph = I[entry.platform];
  return (
    <div className={`pa-act-row is-${entry.status}`}>
      <span className="pa-act-row__time">{entry.time}</span>
      <span className="pa-act-row__platform">
        <Glyph size={12} brand />
      </span>
      <span className="pa-act-row__dir">{entry.platform}</span>
      <span className="pa-act-row__verb">{entry.verb}</span>
      <span className="pa-act-row__target">{entry.target}</span>
      <span className={`pa-act-row__status is-${entry.status}`}>
        {entry.status === "ok" ? "OK" : entry.status === "err" ? "ERR" : "…"}
        {entry.detail && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>{entry.detail}</span>}
      </span>
    </div>
  );
}

function MessagingActivity({ onClose }) {
  const I = window.PA.Icon;
  const [filter, setFilter] = useStateAct("All");
  const [paused, setPaused] = useStateAct(false);

  const data = [
    { time: "14:02:11", platform: "Telegram", verb: "→ message", target: "@huntharo · #threads-19df", status: "ok", detail: "120 ms" },
    { time: "14:02:10", platform: "Telegram", verb: "← message", target: "@huntharo: \"keep going\"", status: "ok" },
    { time: "14:01:54", platform: "Discord", verb: "→ edit", target: "#pwragent · 1234567890", status: "ok", detail: "98 ms" },
    { time: "14:01:32", platform: "Discord", verb: "→ edit", target: "#pwragent · 1234567890", status: "err", detail: "rate-limit, retrying in 1s" },
    { time: "14:01:19", platform: "Telegram", verb: "→ image", target: "@huntharo · screenshot.png", status: "ok", detail: "642 KB" },
    { time: "14:00:48", platform: "Telegram", verb: "← reaction", target: "@huntharo: 🚀", status: "ok" },
    { time: "14:00:12", platform: "Discord", verb: "← message", target: "@elliot: \"can you split that PR\"", status: "ok" },
    { time: "13:58:33", platform: "Telegram", verb: "↻ getMe", target: "api.telegram.org", status: "ok", detail: "210 ms" },
    { time: "13:58:31", platform: "Discord", verb: "↻ /users/@me", target: "discord.com/api", status: "ok", detail: "187 ms" },
    { time: "13:55:02", platform: "Telegram", verb: "→ message", target: "@huntharo · #threads-19df", status: "ok" },
    { time: "13:54:41", platform: "Discord", verb: "→ message", target: "#pwragent", status: "ok" },
    { time: "13:50:12", platform: "Telegram", verb: "→ status", target: "typing…", status: "ok" },
  ];

  const filtered = filter === "All" ? data : data.filter(d => d.platform === filter);

  return (
    <div className="pa-activity">
      <header className="pa-activity__head">
        <button className="pa-settings__exit" onClick={onClose}>
          <I.ArrowLeft size={13} /> Back to thread
        </button>
        <div style={{ flex: 1 }}>
          <div className="pa-settings__head-eyebrow">Messaging activity</div>
          <h1 className="pa-settings__head-title" style={{ fontSize: 18 }}>Live wire log</h1>
        </div>
        <div className="pa-seg">
          {["All", "Telegram", "Discord"].map((p) => (
            <button key={p} className={`pa-seg__btn ${filter === p ? "is-active" : ""}`} onClick={() => setFilter(p)}>{p}</button>
          ))}
        </div>
        <button className="pa-btn-sec" onClick={() => setPaused(!paused)}>
          {paused ? <><I.Play size={12} /> Resume</> : <><I.Pause size={12} /> Pause</>}
        </button>
        <button className="pa-btn-sec"><I.Download size={12} /> Export</button>
      </header>

      <div className="pa-activity__legend">
        <span className="pa-activity__legend-item"><span className="pa-dot is-ok" /> ok</span>
        <span className="pa-activity__legend-item"><span className="pa-dot is-err" /> error / retry</span>
        <span className="pa-activity__legend-item"><span className="pa-dot is-pending" /> in flight</span>
        <span style={{ flex: 1 }} />
        <span className="pa-activity__legend-item">{filtered.length} events · last 5 min</span>
      </div>

      <div className="pa-activity__rows">
        {filtered.map((e, i) => <ActivityRow key={i} entry={e} />)}
      </div>
    </div>
  );
}

window.PA = window.PA || {};
window.PA.MessagingActivity = MessagingActivity;
