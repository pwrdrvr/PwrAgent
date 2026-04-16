type DesktopApi = {
  ping?: () => string;
  platform?: string;
  versions?: {
    chrome?: string;
    electron?: string;
    node?: string;
  };
};

const sidebarStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  width: "320px",
  padding: "1.25rem",
  borderRight: "1px solid rgba(148, 163, 184, 0.18)",
  background: "#0f172a"
};

const panelStyle: React.CSSProperties = {
  padding: "1rem",
  border: "1px solid rgba(148, 163, 184, 0.18)",
  borderRadius: "8px",
  background: "rgba(15, 23, 42, 0.8)"
};

export function App(): React.ReactElement {
  const shellApi = (window as Window & { pwragnt?: DesktopApi }).pwragnt;

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        color: "#e2e8f0",
        background: "#020617",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
      }}
    >
      <aside style={sidebarStyle}>
        <section style={panelStyle}>
          <h2 style={{ marginTop: 0 }}>Inbox</h2>
          <p style={{ marginBottom: 0 }}>
            Active, blocked, and ready-for-review threads will live here.
          </p>
        </section>

        <section style={panelStyle}>
          <h2 style={{ marginTop: 0 }}>Browse</h2>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button type="button">Recents</button>
            <button type="button">Directories</button>
          </div>
        </section>
      </aside>

      <main style={{ flex: 1, padding: "2rem" }}>
        <h1 style={{ marginTop: 0 }}>PwrAgnt</h1>
        <p>
          Electron shell is wired. The next units will fill in thread
          persistence, agent runtime, and the thread-first navigation model.
        </p>

        <section style={panelStyle}>
          <h2 style={{ marginTop: 0 }}>Desktop bridge</h2>
          <ul>
            <li>Ping: {shellApi?.ping?.() ?? "unavailable"}</li>
            <li>Platform: {shellApi?.platform ?? "unknown"}</li>
            <li>Electron: {shellApi?.versions?.electron ?? "unknown"}</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
