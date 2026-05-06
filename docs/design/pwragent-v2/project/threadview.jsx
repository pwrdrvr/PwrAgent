/* eslint-disable */
const { useState: useStateTV } = React;

function ThreadHeader({ thread }) {
  return (
    <header className="pa-thread__header">
      <h1 className="pa-thread__title">{thread.title}</h1>
    </header>
  );
}

function MessageBlock({ msg }) {
  if (msg.kind === "user") {
    return (
      <article className="pa-msg pa-msg--user">
        <div className="pa-msg__role">USER</div>
        <div className="pa-msg__time">May 4, 1:53 PM</div>
        <div className="pa-msg__body"><p>{msg.text}</p></div>
      </article>
    );
  }
  if (msg.kind === "assistant") {
    return (
      <article className="pa-msg">
        <div className="pa-msg__role">ASSISTANT</div>
        <div className="pa-msg__time">May 4, 1:54 PM</div>
        <div className="pa-msg__body">{msg.body}</div>
      </article>
    );
  }
  if (msg.kind === "explored") {
    return (
      <div className="pa-collapse">
        <span>{msg.text}</span>
        <span className="pa-collapse__time">{msg.time}</span>
      </div>
    );
  }
  return null;
}

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
        <button className="pa-applaunch">
          <I.VSCodeGlyph size={16} />
          VS Code
        </button>
        <button className="pa-applaunch">
          <I.GhosttyGlyph size={16} />
          Ghostty
        </button>
        <span className="pa-composer__spacer" />
        <button className="pa-pick" disabled style={{opacity:.6}}>
          <I.Activity size={11} />
          <span>57%</span>
        </button>
        <button className="pa-send" onClick={send} disabled={!text.trim()}>
          <I.Send size={12} />
          Send
        </button>
      </div>
    </div>
  );
}

function ThreadView({ thread, onSend }) {
  return (
    <main className="pa-thread">
      <div className="pa-thread__inner">
        <section className="pa-transcript">
          {thread.turns.map((m, i) => <MessageBlock key={i} msg={m} />)}
        </section>
        <Composer onSend={onSend} />
      </div>
    </main>
  );
}

window.PA = window.PA || {};
window.PA.ThreadView = ThreadView;
