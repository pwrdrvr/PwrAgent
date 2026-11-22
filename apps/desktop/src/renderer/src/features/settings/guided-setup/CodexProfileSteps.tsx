import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { DesktopApi } from "../../../lib/desktop-api";
import { backendTrademarkNotice } from "./AgentSetupSteps";
import {
  ProfileRowLoginControls,
  ProfileRowLoginStatus,
  rowLoginUrl,
  type RowLoginState,
} from "./CodexLoginRow";
import {
  isValidProfileName,
  normalizeProfileName,
} from "./provisionPairedProfiles";
import { describeProfileNameProblem } from "./codex-profile-names";
import { SetupMark, type SetupMarkId } from "./SetupMark";

/*
 * Codex profile steps for Settings' guided setup: choose one or several
 * new paired profiles, name them and sign each in, then create them. The
 * cards, diagrams, and naming rows are copied from first-run onboarding.
 */

export type CodexProfilesMode = "isolated" | "multiple";

function ChoiceCard(props: {
  eyebrow: string;
  title: string;
  desc: string;
  hint: string;
  badge?: string;
  selected: boolean;
  preview: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`guided-setup__choice${props.selected ? " is-selected" : ""}`}
      onClick={props.onSelect}
      aria-pressed={props.selected}
    >
      {props.badge ? (
        <span className="guided-setup__choice-badge">{props.badge}</span>
      ) : null}
      <span className="guided-setup__choice-eyebrow">{props.eyebrow}</span>
      <span className="guided-setup__choice-title">{props.title}</span>
      <div className="guided-setup__choice-preview">{props.preview}</div>
      <p className="guided-setup__choice-desc">{props.desc}</p>
      <p className="guided-setup__choice-hint">{props.hint}</p>
    </button>
  );
}

/* ----------------------------------------------------------------
   Embedded schematic diagrams for Step 2
   ---------------------------------------------------------------- */

function CodexDiagramIsolated() {
  // Same layout grammar as Multiple, but with a single paired row:
  // a new PwrAgent profile (named "work" by default — editable on the
  // naming step) connects to a brand-new Codex profile
  // of the same name. The footer reuses the Multiple diagram's
  // "UNTOUCHED" pattern so the operator sees that their existing Codex
  // default stays exactly where it is. This is what makes the data-leak
  // guarantee land visually for the single-profile-isolated case.
  return (
    <div className="guided-setup__codex guided-setup__codex--multiple">
      <div className="guided-setup__codex-multi-pairs">
        <div className="guided-setup__codex-multi-pair">
          <CodexNode label="work" mark="pwragent" accent compact tight />
          <span className="guided-setup__codex-link guided-setup__codex-link--small">→</span>
          <CodexNode
            label="work"
            mark="codex"
            meta="new — your login"
            compact
            tight
          />
        </div>
      </div>
      <div className="guided-setup__codex-multi-default">
        <span className="guided-setup__codex-multi-default-label">
          Untouched
        </span>
        <CodexNode label="(default)" mark="pwragent" muted dashed compact tight />
        <span className="guided-setup__codex-link guided-setup__codex-link--dashed">
          ╌╌
        </span>
        <CodexNode
          label="Codex default"
          mark="codex"
          meta="your existing login"
          muted
          dashed
          compact
          tight
        />
      </div>
    </div>
  );
}

function CodexDiagramMultiple() {
  // Three PwrAgent profiles (work, personal, projects) each map to a
  // Codex profile of the same name. Codex `personal` and `projects`
  // happen to share an upstream OpenAI login (joe@example.com) — they're
  // still separate Codex profile dirs under ~/.codex/auth-profiles, but
  // both auth as the same account. `work` uses a different login.
  // The existing `default` Codex profile is left untouched on disk and
  // is intentionally shown as a faded dashed node in the footer so the
  // operator sees "we don't touch your default Codex" at a glance.
  return (
    <div className="guided-setup__codex guided-setup__codex--multiple">
      <div className="guided-setup__codex-multi-pairs">
        <div className="guided-setup__codex-multi-pair">
          <CodexNode label="work" mark="pwragent" accent compact tight />
          <span className="guided-setup__codex-link guided-setup__codex-link--small">→</span>
          <CodexNode
            label="work"
            mark="codex"
            meta="work@example.com"
            compact
            tight
          />
        </div>
        <div className="guided-setup__codex-multi-pair">
          <CodexNode label="personal" mark="pwragent" accent compact tight />
          <span className="guided-setup__codex-link guided-setup__codex-link--small">→</span>
          <CodexNode
            label="personal"
            mark="codex"
            meta="joe@example.com"
            compact
            tight
          />
        </div>
        <div className="guided-setup__codex-multi-pair">
          <CodexNode label="projects" mark="pwragent" accent compact tight />
          <span className="guided-setup__codex-link guided-setup__codex-link--small">→</span>
          <CodexNode
            label="projects"
            mark="codex"
            meta="joe@example.com"
            compact
            tight
          />
        </div>
      </div>
      <div className="guided-setup__codex-multi-default">
        <span className="guided-setup__codex-multi-default-label">
          Untouched
        </span>
        <CodexNode label="(default)" mark="pwragent" muted dashed compact tight />
        <span className="guided-setup__codex-link guided-setup__codex-link--dashed">
          ╌╌
        </span>
        <CodexNode
          label="Codex default"
          mark="codex"
          meta="your existing login"
          muted
          dashed
          compact
          tight
        />
      </div>
    </div>
  );
}

function CodexNode(props: {
  label: string;
  mark: Extract<SetupMarkId, "pwragent" | "codex">;
  meta?: string;
  accent?: boolean;
  compact?: boolean;
  /** Even tighter padding for high-density diagrams (Multiple). */
  tight?: boolean;
  /** Render as a desaturated/hint state — used for the "untouched" pair. */
  muted?: boolean;
  /** Switch the border to dashed (companion to muted). */
  dashed?: boolean;
}) {
  const classes = ["guided-setup__codex-node"];
  if (props.accent) classes.push("is-accent");
  if (props.compact) classes.push("is-compact");
  if (props.tight) classes.push("is-tight");
  if (props.muted) classes.push("is-muted");
  if (props.dashed) classes.push("is-dashed");
  return (
    <div className={classes.join(" ")}>
      <SetupMark mark={props.mark} className="guided-setup__codex-avatar" />
      <div className="guided-setup__codex-node-text">
        <div className="guided-setup__codex-label">{props.label}</div>
        {props.meta ? (
          <div className="guided-setup__codex-meta">{props.meta}</div>
        ) : null}
      </div>
    </div>
  );
}

export function CodexProfileChoiceStep(props: {
  value: CodexProfilesMode;
  onChange: (value: CodexProfilesMode) => void;
}) {
  return (
    <div>
      <header className="guided-setup__head">
        <h1 className="guided-setup__title">
          Add a PwrAgent profile with its own Codex login
        </h1>
        <p className="guided-setup__sub">
          Each new profile gets its own threads, settings, and secrets, paired
          with a Codex login of the same name. This profile and your existing
          Codex login stay exactly as they are.
        </p>
      </header>
      <div className="guided-setup__choices guided-setup__choices--2">
        <ChoiceCard
          eyebrow="One profile"
          title="Create one new profile"
          desc="Keep a separate set of threads, or sign in with a different Codex account, without touching this profile."
          hint="Best for: a second identity, such as work and personal."
          badge={props.value === "isolated" ? "Selected" : undefined}
          selected={props.value === "isolated"}
          onSelect={() => props.onChange("isolated")}
          preview={<CodexDiagramIsolated />}
        />
        <ChoiceCard
          eyebrow="Several · power user"
          title="Set up several profiles at once"
          desc="Name up to 5 paired profiles. Each gets its own login and identity."
          hint="Best for: operators with multiple distinct identities."
          badge={props.value === "multiple" ? "Selected" : undefined}
          selected={props.value === "multiple"}
          onSelect={() => props.onChange("multiple")}
          preview={<CodexDiagramMultiple />}
        />
      </div>
      <p className="guided-setup__trademark-note">
        {backendTrademarkNotice("codex")}
      </p>
    </div>
  );
}

export type CodexProfilesAuthSnapshot = {
  allAuthed: boolean;
  namedRows: number;
};

/** Sign-in state per normalized row name. */
export type CodexProfileLoginStates = Record<string, RowLoginState>;

/**
 * Name the new profiles and sign each one in. A row's name locks once its
 * sign-in starts, so the login and the profile it belongs to can't drift
 * apart. Nothing runs until Log in or Check status is clicked.
 */
export function NameCodexProfilesStep(props: {
  mode: CodexProfilesMode;
  names: string[];
  onChange: (next: string[]) => void;
  existingProfiles: readonly string[];
  desktopApi?: DesktopApi;
  onAuthStateChange: (snapshot: CodexProfilesAuthSnapshot) => void;
  /** Owned by the flow, not this step: the step unmounts on Continue, and
   *  Back must still find the rows it signed in. Keyed by the committed row
   *  name, so edits before Log in don't carry orphan state. */
  loginStates: CodexProfileLoginStates;
  setLoginStates: Dispatch<SetStateAction<CodexProfileLoginStates>>;
}) {
  const maxCount = props.mode === "isolated" ? 1 : 5;
  const isSingle = props.mode === "isolated";
  const { loginStates, setLoginStates } = props;
  const apiRef = useRef(props.desktopApi);
  apiRef.current = props.desktopApi;

  const stateFor = (name: string): RowLoginState =>
    loginStates[name] ?? { kind: "idle" };

  const isRowLocked = (name: string): boolean => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const state = stateFor(normalizeProfileName(trimmed)).kind;
    return state === "starting" || state === "waiting" || state === "checking" || state === "ok";
  };

  const setAt = (idx: number, value: string): void => {
    if (isRowLocked(props.names[idx] ?? "")) return;
    const next = [...props.names];
    next[idx] = value;
    props.onChange(next);
  };
  const removeAt = (idx: number): void => {
    if (isRowLocked(props.names[idx] ?? "")) return;
    const next = [...props.names];
    next.splice(idx, 1);
    props.onChange(next);
  };
  const addOne = (): void => {
    if (props.names.length >= maxCount) return;
    props.onChange([...props.names, ""]);
  };

  const refreshStatus = useCallback(async (name: string): Promise<void> => {
    const api = apiRef.current;
    if (!api?.checkCodexAuthProfileStatus || !isValidProfileName(name)) return;
    setLoginStates((prev) => {
      const existing = prev[name];
      if (existing?.kind === "ok") return prev;
      return {
        ...prev,
        [name]: { kind: "checking", url: existing ? rowLoginUrl(existing) : undefined },
      };
    });
    try {
      const result = await api.checkCodexAuthProfileStatus({ profile: name });
      if (result.authenticated) {
        setLoginStates((prev) => ({
          ...prev,
          [name]: { kind: "ok", email: result.email, planType: result.planType },
        }));
      } else {
        setLoginStates((prev) => ({
          ...prev,
          [name]: {
            kind: "waiting",
            url: prev[name] ? rowLoginUrl(prev[name]!) : undefined,
            detail: result.detail,
          },
        }));
      }
    } catch (caught) {
      setLoginStates((prev) => ({
        ...prev,
        [name]: {
          kind: "error",
          detail: caught instanceof Error ? caught.message : String(caught),
        },
      }));
    }
  }, [setLoginStates]);

  /**
   * Create the Codex auth profile shell if it is missing (idempotent),
   * start `codex login`, and show the login URL so the operator can open it
   * in the browser that is signed in to the right account.
   */
  const startLogin = useCallback(
    async (name: string): Promise<void> => {
      const api = apiRef.current;
      if (
        !api?.createCodexAuthProfile
        || !api.startCodexAuthProfileLogin
        || !isValidProfileName(name)
      ) {
        return;
      }
      setLoginStates((prev) => ({ ...prev, [name]: { kind: "starting" } }));
      try {
        await api.createCodexAuthProfile({ profile: name });
        const result = await api.startCodexAuthProfileLogin({ profile: name });
        if (result.authenticated) {
          await refreshStatus(name);
          return;
        }
        setLoginStates((prev) => ({
          ...prev,
          [name]: { kind: "waiting", url: result.loginUrl, detail: result.detail },
        }));
      } catch (caught) {
        setLoginStates((prev) => ({
          ...prev,
          [name]: {
            kind: "error",
            detail: caught instanceof Error ? caught.message : String(caught),
          },
        }));
      }
    },
    [refreshStatus, setLoginStates],
  );

  const copyLoginUrl = useCallback(async (url: string | undefined): Promise<void> => {
    const api = apiRef.current;
    if (!url || !api?.copyText) return;
    try {
      await api.copyText(url);
    } catch {
      // Best effort; the operator can still start the login again.
    }
  }, []);

  // Coming back from the browser: re-check rows that started a login.
  useEffect(() => {
    const api = apiRef.current;
    if (!api?.onWindowFocus) return undefined;
    const waiting = Object.entries(loginStates)
      .filter(([, state]) => state.kind === "waiting")
      .map(([name]) => name);
    if (waiting.length === 0) return undefined;
    return api.onWindowFocus(() => {
      for (const name of waiting) void refreshStatus(name);
    });
  }, [loginStates, refreshStatus]);

  const onAuthStateChange = props.onAuthStateChange;
  useEffect(() => {
    const validNames = props.names
      .map((name) => normalizeProfileName(name))
      .filter(Boolean);
    const allAuthed =
      validNames.length > 0
      && validNames.every((name) => (loginStates[name] ?? { kind: "idle" }).kind === "ok");
    onAuthStateChange({ allAuthed, namedRows: validNames.length });
  }, [loginStates, onAuthStateChange, props.names]);

  return (
    <div>
      <header className="guided-setup__head">
        <h1 className="guided-setup__title">
          {isSingle
            ? "Name and log in to your new profile"
            : "Name and log in to your new profiles"}
        </h1>
        <p className="guided-setup__sub">
          {isSingle ? "The name applies to " : "Up to 5. Each name applies to "}
          <strong>both sides</strong>: a new PwrAgent profile under{" "}
          <code>~/.pwragent/profiles/</code> and a matching Codex auth profile
          under <code>~/.codex/auth-profiles/</code>. Click{" "}
          <strong>Log in</strong> to start the Codex sign-in for that profile.
          Tip: focus the browser window that&rsquo;s already signed in to the
          right account first, or use <strong>Copy URL</strong> to paste the
          login link into the browser you want.
        </p>
      </header>
      <div className="guided-setup__profile-list">
        {props.names.map((name, idx) => {
          const normalized = normalizeProfileName(name);
          const problem = describeProfileNameProblem(
            name,
            props.names,
            props.existingProfiles,
          );
          const state = normalized ? stateFor(normalized) : { kind: "idle" as const };
          const locked = isRowLocked(name);
          const rowLabel = normalized || `profile ${idx + 1}`;
          const errorId = `guided-profile-name-error-${idx}`;
          return (
            <div
              key={idx}
              className={`guided-setup__profile-row guided-setup__profile-row--has-login is-${state.kind}`}
            >
              <div className="guided-setup__profile-row-top">
                <span className="guided-setup__profile-num">{idx + 1}</span>
                <input
                  type="text"
                  className={`guided-setup__profile-input${problem ? " is-invalid" : ""}`}
                  placeholder={isSingle ? "work" : "profile-name"}
                  aria-label={`Profile ${idx + 1} name`}
                  aria-invalid={Boolean(problem)}
                  aria-describedby={problem ? errorId : undefined}
                  value={name}
                  onChange={(e) => setAt(idx, e.target.value)}
                  readOnly={locked}
                />
                <ProfileRowLoginControls
                  valid={!problem && Boolean(normalized)}
                  state={state}
                  rowLabel={rowLabel}
                  onLogin={() => void startLogin(normalized)}
                  onCheck={() => void refreshStatus(normalized)}
                  onCopyUrl={() => void copyLoginUrl(rowLoginUrl(state))}
                />
                {!isSingle && props.names.length > 1 ? (
                  <button
                    type="button"
                    className="guided-setup__btn guided-setup__btn--link"
                    onClick={() => removeAt(idx)}
                    aria-label={`Remove profile ${idx + 1}`}
                    disabled={locked}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {problem ? (
                <div
                  id={errorId}
                  className="guided-setup__profile-row-detail guided-setup__profile-row-detail--error"
                >
                  {problem}
                </div>
              ) : (
                <ProfileRowLoginStatus state={state} />
              )}
            </div>
          );
        })}
        {!isSingle && props.names.length < maxCount ? (
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--ghost guided-setup__profile-add"
            onClick={addOne}
          >
            + Add another profile
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function CodexProfilesPreviewList(props: {
  names: readonly string[];
  children?: ReactNode;
}) {
  return (
    <div className="guided-setup__codex guided-setup__codex--multiple">
      <div className="guided-setup__codex-multi-pairs">
        {props.names.map((name) => (
          <div key={name} className="guided-setup__codex-multi-pair">
            <CodexNode label={name} mark="pwragent" accent compact tight />
            <span className="guided-setup__codex-link guided-setup__codex-link--small">→</span>
            <CodexNode label={name} mark="codex" meta="new Codex login" compact tight />
          </div>
        ))}
      </div>
      {props.children}
    </div>
  );
}
