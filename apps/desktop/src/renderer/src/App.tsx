import { useEffect, useMemo, useState } from "react";
import type {
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerThreadSummary
} from "@pwragnt/shared";

type DesktopApi = {
  ping?: () => string;
  listThreads?: (
    request?: AppServerListThreadsRequest
  ) => Promise<AppServerListThreadsResponse>;
  platform?: string;
  versions?: {
    chrome?: string;
    electron?: string;
    node?: string;
  };
};

type BrowseMode = "recents" | "directories";

const colors = {
  app: "#0a0b0d",
  sidebar: "#15181b",
  panel: "#1b1f24",
  panelAlt: "#121518",
  border: "rgba(228, 232, 220, 0.12)",
  text: "#f2f1ea",
  muted: "#a5ab9b",
  accent: "#cbff45",
  accentMuted: "rgba(203, 255, 69, 0.16)"
} as const;

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) {
    return "just now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "just now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(timestamp);
}

function formatUpdatedAt(timestamp: number | undefined): string {
  if (!timestamp) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function getPrimarySummary(thread: AppServerThreadSummary): string {
  return (
    thread.summary?.trim() ||
    `${thread.linkedDirectories.length || 0} linked director${
      thread.linkedDirectories.length === 1 ? "y" : "ies"
    }`
  );
}

function ThreadList(props: {
  threads: AppServerThreadSummary[];
  selectedThreadId?: string;
  onSelectThread: (thread: AppServerThreadSummary) => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflowY: "auto",
        marginTop: "0.75rem",
        paddingRight: "0.25rem"
      }}
    >
      {props.threads.map((thread) => {
        const isSelected = thread.id === props.selectedThreadId;

        return (
          <button
            key={thread.id}
            type="button"
            onClick={() => props.onSelectThread(thread)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.9rem 0.95rem",
              marginBottom: "0.55rem",
              borderRadius: "8px",
              border: `1px solid ${
                isSelected ? colors.accent : "rgba(228, 232, 220, 0.08)"
              }`,
              background: isSelected ? colors.panel : "transparent",
              color: colors.text,
              textAlign: "left",
              cursor: "pointer"
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "0.75rem"
              }}
            >
              <span
                style={{
                  fontSize: "0.98rem",
                  fontWeight: 600,
                  lineHeight: 1.25
                }}
              >
                {thread.title}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  color: colors.muted,
                  fontSize: "0.78rem"
                }}
              >
                {formatRelativeTime(thread.updatedAt)}
              </span>
            </div>

            <p
              style={{
                margin: 0,
                color: colors.muted,
                fontSize: "0.88rem",
                lineHeight: 1.35
              }}
            >
              {getPrimarySummary(thread)}
            </p>

            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
              {thread.linkedDirectories.map((directory) => (
                <span
                  key={directory.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    minHeight: "1.65rem",
                    padding: "0 0.55rem",
                    borderRadius: "999px",
                    background: colors.accentMuted,
                    color: colors.text,
                    fontSize: "0.78rem"
                  }}
                >
                  {directory.label}
                </span>
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function DirectoryList(props: {
  threads: AppServerThreadSummary[];
  selectedThreadId?: string;
  onSelectThread: (thread: AppServerThreadSummary) => void;
}): React.ReactElement {
  const groupedDirectories = new Map<
    string,
    { label: string; path: string; threads: AppServerThreadSummary[] }
  >();

  for (const thread of props.threads) {
    for (const directory of thread.linkedDirectories) {
      const existing = groupedDirectories.get(directory.id);
      if (existing) {
        existing.threads.push(thread);
        continue;
      }
      groupedDirectories.set(directory.id, {
        label: directory.label,
        path: directory.path,
        threads: [thread]
      });
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflowY: "auto",
        marginTop: "0.75rem",
        paddingRight: "0.25rem"
      }}
    >
      {[...groupedDirectories.values()].map((directory) => (
        <section
          key={directory.path}
          style={{
            marginBottom: "0.85rem",
            padding: "0.85rem",
            borderRadius: "8px",
            background: colors.panel,
            border: `1px solid ${colors.border}`
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.2rem",
              marginBottom: "0.7rem"
            }}
          >
            <span style={{ fontSize: "0.92rem", fontWeight: 700 }}>
              {directory.label}
            </span>
            <span style={{ fontSize: "0.78rem", color: colors.muted }}>
              {directory.threads.length} thread
              {directory.threads.length === 1 ? "" : "s"}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {directory.threads.map((thread) => {
              const isSelected = thread.id === props.selectedThreadId;
              return (
                <button
                  key={`${directory.path}-${thread.id}`}
                  type="button"
                  onClick={() => props.onSelectThread(thread)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    padding: "0.7rem 0.75rem",
                    borderRadius: "8px",
                    border: `1px solid ${
                      isSelected ? colors.accent : "rgba(228, 232, 220, 0.08)"
                    }`,
                    background: isSelected ? colors.panelAlt : "transparent",
                    color: colors.text,
                    cursor: "pointer",
                    textAlign: "left"
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.88rem",
                      fontWeight: 600,
                      lineHeight: 1.3
                    }}
                  >
                    {thread.title}
                  </span>
                  <span style={{ color: colors.muted, fontSize: "0.78rem" }}>
                    {formatRelativeTime(thread.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function App(): React.ReactElement {
  const shellApi = (window as Window & { pwragnt?: DesktopApi }).pwragnt;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [threadState, setThreadState] = useState<{
    loading: boolean;
    error?: string;
    response?: AppServerListThreadsResponse;
  }>({
    loading: true
  });
  const [selectedThreadId, setSelectedThreadId] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function loadThreads(): Promise<void> {
      try {
        const response = await shellApi?.listThreads?.({ backend: "codex" });
        if (cancelled) {
          return;
        }

        setThreadState({
          loading: false,
          response
        });
        setSelectedThreadId((current) => current ?? response?.threads[0]?.id);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setThreadState({
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    void loadThreads();

    return () => {
      cancelled = true;
    };
  }, [shellApi]);

  const threads = threadState.response?.threads ?? [];
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? threads[0],
    [selectedThreadId, threads]
  );

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        color: colors.text,
        background: colors.app,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
      }}
    >
      <aside
        style={{
          display: "flex",
          flexDirection: "column",
          width: "410px",
          minWidth: "410px",
          padding: "1.25rem 1rem 1rem 1.1rem",
          borderRight: `1px solid ${colors.border}`,
          background: colors.sidebar
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            padding: "0 0.15rem 1rem"
          }}
        >
          <div>
            <div
              style={{
                color: colors.accent,
                fontSize: "0.8rem",
                fontWeight: 700,
                letterSpacing: 0,
                textTransform: "uppercase"
              }}
            >
              PwrAgnt
            </div>
            <h1
              style={{
                margin: "0.3rem 0 0",
                fontSize: "1.7rem",
                lineHeight: 1.05
              }}
            >
              Threads
            </h1>
          </div>

          <button
            type="button"
            style={{
              width: "2.1rem",
              height: "2.1rem",
              borderRadius: "8px",
              border: `1px solid ${colors.border}`,
              background: colors.panel,
              color: colors.text,
              fontSize: "1.2rem",
              cursor: "pointer"
            }}
            aria-label="New thread"
          >
            +
          </button>
        </div>

        <section
          style={{
            padding: "0.95rem",
            borderRadius: "8px",
            background: colors.panelAlt,
            border: `1px solid ${colors.border}`
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.75rem"
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.08rem" }}>Inbox</h2>
            <span
              style={{
                minWidth: "1.7rem",
                height: "1.7rem",
                borderRadius: "999px",
                background: colors.accentMuted,
                color: colors.text,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.82rem"
              }}
            >
              0
            </span>
          </div>
          <p
            style={{
              margin: "0.65rem 0 0",
              color: colors.muted,
              fontSize: "0.9rem",
              lineHeight: 1.35
            }}
          >
            Nothing is waiting on you yet.
          </p>
        </section>

        <section
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            marginTop: "1rem",
            padding: "0.95rem",
            borderRadius: "8px",
            background: colors.panelAlt,
            border: `1px solid ${colors.border}`
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.75rem"
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.08rem" }}>Browse</h2>
            <div
              style={{
                display: "inline-flex",
                padding: "0.2rem",
                background: colors.panel,
                borderRadius: "8px",
                border: `1px solid ${colors.border}`
              }}
            >
              {(["recents", "directories"] as const).map((mode) => {
                const active = browseMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setBrowseMode(mode)}
                    style={{
                      minWidth: "6.4rem",
                      height: "2rem",
                      padding: "0 0.8rem",
                      border: 0,
                      borderRadius: "6px",
                      background: active ? colors.accent : "transparent",
                      color: active ? "#0f1300" : colors.muted,
                      cursor: "pointer",
                      fontSize: "0.86rem",
                      fontWeight: 600,
                      textTransform: "capitalize"
                    }}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          </div>

          {threadState.loading ? (
            <p style={{ margin: "1rem 0 0", color: colors.muted }}>
              Loading Codex threads...
            </p>
          ) : threadState.error ? (
            <p style={{ margin: "1rem 0 0", color: "#ff9d8b", lineHeight: 1.4 }}>
              {threadState.error}
            </p>
          ) : browseMode === "directories" ? (
            <DirectoryList
              threads={threads}
              selectedThreadId={selectedThread?.id}
              onSelectThread={(thread) => setSelectedThreadId(thread.id)}
            />
          ) : (
            <ThreadList
              threads={threads}
              selectedThreadId={selectedThread?.id}
              onSelectThread={(thread) => setSelectedThreadId(thread.id)}
            />
          )}
        </section>
      </aside>

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "1.5rem 1.75rem 1.75rem"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            paddingBottom: "1rem",
            borderBottom: `1px solid ${colors.border}`
          }}
        >
          <div>
            <div
              style={{
                color: colors.muted,
                fontSize: "0.82rem",
                textTransform: "uppercase",
                fontWeight: 700
              }}
            >
              Recent view
            </div>
            <h2 style={{ margin: "0.3rem 0 0", fontSize: "1.85rem" }}>
              {selectedThread?.title ?? "No thread selected"}
            </h2>
          </div>

          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.45rem 0.7rem",
              borderRadius: "999px",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              color: colors.muted,
              fontSize: "0.82rem"
            }}
          >
            <span
              style={{
                width: "0.5rem",
                height: "0.5rem",
                borderRadius: "999px",
                background: colors.accent
              }}
            />
            Codex app server
          </div>
        </div>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 0.9fr)",
            gap: "1rem",
            flex: 1,
            paddingTop: "1rem"
          }}
        >
          <div
            style={{
              padding: "1.2rem",
              borderRadius: "8px",
              background: colors.panel,
              border: `1px solid ${colors.border}`
            }}
          >
            <p
              style={{
                margin: 0,
                color: colors.muted,
                fontSize: "0.84rem",
                textTransform: "uppercase",
                fontWeight: 700
              }}
            >
              Summary
            </p>
            <p
              style={{
                margin: "0.85rem 0 0",
                fontSize: "1.05rem",
                lineHeight: 1.55,
                color: selectedThread ? colors.text : colors.muted
              }}
            >
              {selectedThread
                ? getPrimarySummary(selectedThread)
                : "Start a thread or pick one from Recents."}
            </p>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1rem"
            }}
          >
            <div
              style={{
                padding: "1.2rem",
                borderRadius: "8px",
                background: colors.panel,
                border: `1px solid ${colors.border}`
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: colors.muted,
                  fontSize: "0.84rem",
                  textTransform: "uppercase",
                  fontWeight: 700
                }}
              >
                Linked directories
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                  marginTop: "0.85rem"
                }}
              >
                {selectedThread?.linkedDirectories.length ? (
                  selectedThread.linkedDirectories.map((directory) => (
                    <span
                      key={directory.id}
                      style={{
                        display: "inline-flex",
                        minHeight: "1.8rem",
                        alignItems: "center",
                        padding: "0 0.65rem",
                        borderRadius: "999px",
                        background: colors.accentMuted,
                        color: colors.text,
                        fontSize: "0.84rem"
                      }}
                    >
                      {directory.label}
                    </span>
                  ))
                ) : (
                  <span style={{ color: colors.muted, fontSize: "0.9rem" }}>
                    No directories linked yet
                  </span>
                )}
              </div>
            </div>

            <div
              style={{
                padding: "1.2rem",
                borderRadius: "8px",
                background: colors.panel,
                border: `1px solid ${colors.border}`
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: colors.muted,
                  fontSize: "0.84rem",
                  textTransform: "uppercase",
                  fontWeight: 700
                }}
              >
                Runtime
              </p>
              <dl
                style={{
                  margin: "0.85rem 0 0",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  rowGap: "0.55rem",
                  columnGap: "0.9rem",
                  fontSize: "0.9rem"
                }}
              >
                <dt style={{ color: colors.muted }}>Updated</dt>
                <dd style={{ margin: 0 }}>
                  {selectedThread ? formatUpdatedAt(selectedThread.updatedAt) : "Unknown"}
                </dd>
                <dt style={{ color: colors.muted }}>Platform</dt>
                <dd style={{ margin: 0 }}>{shellApi?.platform ?? "unknown"}</dd>
                <dt style={{ color: colors.muted }}>Electron</dt>
                <dd style={{ margin: 0 }}>
                  {shellApi?.versions?.electron ?? "unknown"}
                </dd>
                <dt style={{ color: colors.muted }}>Bridge</dt>
                <dd style={{ margin: 0 }}>{shellApi?.ping?.() ?? "unavailable"}</dd>
              </dl>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
