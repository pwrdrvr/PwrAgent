import { useId, useRef, useState } from "react";
import {
  BOAT_SANDBOX_TYPES,
  BOAT_SANDBOX_TYPE_LABELS,
  DEFAULT_BOAT_SANDBOX_POLICY,
  boatSandboxTypeRank,
  normalizeBoatApiKey,
  type BoatLinkTarget,
  type BoatSandboxPolicy,
  type BoatSandboxType,
  type McpConnectionStatus,
} from "@pwragent/shared/contracts/mcp-connections";
import { Select, type SelectOption } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "./SettingsSwitch";

type Notice = { kind: "error" | "info" | "success" | "working"; text: string };

const TTL_MINUTES = [30, 60, 120, 240, 480, 1_440] as const;

function ttlLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${minutes} minutes`;
}

/** The fixed choices, plus the stored value when it is not one of them. */
function ttlOptions(current: number, limit?: number): SelectOption<string>[] {
  const values = new Set<number>([...TTL_MINUTES, current]);
  return [...values]
    .filter((minutes) => limit === undefined || minutes <= limit)
    .toSorted((left, right) => left - right)
    .map((minutes) => ({ value: String(minutes), label: ttlLabel(minutes) }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Boat page, opened by main from its fixed list. */
function BoatLink(props: {
  desktopApi?: DesktopApi;
  label: string;
  target: BoatLinkTarget;
  onNotice: (notice: Notice) => void;
}) {
  const open = props.desktopApi?.openBoatLink;
  return (
    <button
      className="settings-sandboxer-link"
      disabled={!open}
      type="button"
      onClick={() => {
        if (!open) return;
        void open(props.target).then(
          (response) => {
            if (!response.opened) {
              props.onNotice({
                kind: "error",
                text: response.error ?? "Could not open the Boat page.",
              });
            }
          },
          (error: unknown) => props.onNotice({ kind: "error", text: errorText(error) }),
        );
      }}
    >
      {props.label}
    </button>
  );
}

function accountLine(connection: McpConnectionStatus): string | undefined {
  const account = connection.boatAccount;
  if (!account) return undefined;
  const parts: string[] = [];
  if (account.login) parts.push(account.login);
  if (account.plan) parts.push(`${account.plan} plan`);
  if (account.activeSandboxes !== undefined) {
    parts.push(account.maxActiveSandboxes !== undefined
      ? `${account.activeSandboxes} of ${account.maxActiveSandboxes} sandboxes running`
      : `${account.activeSandboxes} sandboxes running`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Boat's place in its Settings row: what it is and the key field until a key
 * is stored, then the account the key belongs to.
 *
 * The key is write-only here. It goes to main once, main checks it against
 * Boat and stores it encrypted, and nothing sends it back: not to this
 * window, not to an agent, not to a sandbox.
 */
export function BoatSetupDetail(props: {
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  detail: string;
  disabled: boolean;
  onChanged: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const errorId = useId();
  const hintId = useId();
  const connect = props.desktopApi?.connectBoat;
  const rejected = props.connection.state === "reauthorization_required";
  const needsKey = !props.connection.configured || rejected;
  const links = (
    <div className="settings-sandboxer-links">
      <BoatLink desktopApi={props.desktopApi} label="What is Boat?" target="home" onNotice={props.onNotice} />
      <BoatLink desktopApi={props.desktopApi} label="Pricing" target="pricing" onNotice={props.onNotice} />
      <BoatLink desktopApi={props.desktopApi} label="API keys" target="api_keys" onNotice={props.onNotice} />
      {props.connection.configured ? (
        <BoatLink desktopApi={props.desktopApi} label="Dashboard" target="dashboard" onNotice={props.onNotice} />
      ) : null}
    </div>
  );

  const submit = async (): Promise<void> => {
    if (!connect || props.disabled || connectingRef.current) return;
    const apiKey = normalizeBoatApiKey(value);
    if (!apiKey) {
      setInvalid("That is not a Boat API key. Boat keys start with boat_.");
      return;
    }
    connectingRef.current = true;
    setConnecting(true);
    setInvalid(undefined);
    try {
      await connect({ apiKey });
      setValue("");
      props.onNotice({
        kind: "success",
        text: "Boat is connected. The key is stored encrypted on this computer.",
      });
      props.onChanged();
    } catch (error) {
      setInvalid(errorText(error));
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  };

  if (!needsKey) {
    const account = accountLine(props.connection);
    const blocked = props.connection.boatAccount?.canStart === false
      ? props.connection.boatAccount.blockedReason ?? "Boat will not start new sandboxes for this account right now."
      : undefined;
    return (
      <>
        {account ? <p className="settings-mcp-row__state">{account}</p> : null}
        {blocked ? <p className="settings-mcp-row__error">{blocked}</p> : null}
        <p className="settings-mcp-row__state">{props.detail}</p>
        {links}
      </>
    );
  }

  return (
    <>
      <div className="settings-sandboxer-about">
        <p>
          <strong>Boat</strong> runs cloud Linux machines your agent can build and test
          on, while the thread stays on this computer. It is a separate paid service,
          billed per second while a machine runs.
        </p>
        {links}
      </div>
      {rejected ? (
        <p className="settings-mcp-row__error">
          Boat rejected the stored key. Paste a new one to reconnect.
        </p>
      ) : null}
      <div className="settings-boat-key">
        <input
          aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
          aria-invalid={invalid ? true : undefined}
          aria-label="Boat API key"
          autoComplete="off"
          className="settings-input"
          disabled={props.disabled || connecting || !connect}
          placeholder="boat_…"
          spellCheck={false}
          type="password"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setInvalid(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={props.disabled || connecting || !connect || !value.trim()}
          type="button"
          onClick={() => void submit()}
        >
          {connecting ? "Checking key..." : "Connect Boat"}
        </button>
      </div>
      {invalid ? (
        <p className="settings-mcp-row__error" id={errorId} role="alert">{invalid}</p>
      ) : null}
      <p className="settings-mcp-row__state" id={hintId}>
        Create a key in Boat, then paste it here. PwrAgent stores it encrypted on
        this computer and makes every Boat request itself. Agents get sandbox
        tools, never the key.
      </p>
    </>
  );
}

/**
 * The limits PwrAgent holds every Boat request to. Each control writes at
 * once, as the row's other switches do.
 */
export function BoatPolicyControls(props: {
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  disabled: boolean;
  onChanged: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const defaultTypeId = useId();
  const maxTypeId = useId();
  const defaultTtlId = useId();
  const maxTtlId = useId();
  const setPolicy = props.desktopApi?.setBoatSandboxPolicy;
  const setCleanup = props.desktopApi?.setBoatCleanupOnPrClose;
  const policy = props.connection.boatPolicy ?? DEFAULT_BOAT_SANDBOX_POLICY;
  const disabled = props.disabled || busy;

  const write = (run: () => Promise<unknown>) => {
    setBusy(true);
    void run().then(
      () => props.onChanged(),
      (error: unknown) => props.onNotice({ kind: "error", text: errorText(error) }),
    ).finally(() => setBusy(false));
  };
  const change = (next: Partial<BoatSandboxPolicy>) => {
    if (setPolicy) write(() => setPolicy({ policy: { ...policy, ...next } }));
  };
  const typeOptions = (limit?: BoatSandboxType): SelectOption<BoatSandboxType>[] =>
    BOAT_SANDBOX_TYPES
      .filter((type) => !limit || boatSandboxTypeRank(type) <= boatSandboxTypeRank(limit))
      .map((type) => ({ value: type, label: BOAT_SANDBOX_TYPE_LABELS[type] }));

  return (
    <>
      {setPolicy ? (
        <div className="settings-mcp-row__policy-item">
          <SettingsSwitch
            checked={policy.keepCredentialsOut}
            disabled={disabled}
            label="Keep my credentials out of Boat sandboxes"
            onChange={(keepCredentialsOut) => change({ keepCredentialsOut })}
          />
          <span className="settings-mcp-row__policy-text">
            <span className="settings-mcp-row__policy-label">
              Keep my credentials out of sandboxes
            </span>
            <span className="settings-mcp-row__policy-hint">
              {policy.keepCredentialsOut
                ? "Sandboxes start without your Boat account's GitHub token, secrets, or model keys."
                : "Boat puts your account's GitHub token, secrets, and model keys in each sandbox, where the agent's commands can read them."}
            </span>
          </span>
        </div>
      ) : null}
      {setCleanup ? (
        <div className="settings-mcp-row__policy-item">
          <SettingsSwitch
            // Absent reads as on, as it does for Sandboxer.
            checked={props.connection.boatCleanupOnPrClose !== false}
            disabled={disabled}
            label="Clean up Boat sandboxes when PRs close"
            onChange={(enabled) => write(() => setCleanup({ enabled }))}
          />
          <span className="settings-mcp-row__policy-text">
            <span className="settings-mcp-row__policy-label">
              Clean up when PRs close
            </span>
            <span className="settings-mcp-row__policy-hint">
              Delete each sandbox a thread created once all of its PRs merge or close.
            </span>
          </span>
        </div>
      ) : null}
      {setPolicy ? (
        <div className="settings-mcp-row__policy-item settings-mcp-row__policy-item--choice">
          <span className="settings-mcp-row__policy-text">
            <span className="settings-mcp-row__policy-label">Sandbox limits</span>
            <span className="settings-boat-limits">
              <span className="settings-boat-limit">
                <span id={defaultTypeId}>Default size</span>
                <Select
                  aria-labelledby={defaultTypeId}
                  className="settings-select settings-select--chip"
                  disabled={disabled}
                  options={typeOptions(policy.maxType)}
                  value={policy.defaultType}
                  onChange={(defaultType) => change({ defaultType })}
                />
              </span>
              <span className="settings-boat-limit">
                <span id={maxTypeId}>Largest size</span>
                <Select
                  aria-labelledby={maxTypeId}
                  className="settings-select settings-select--chip"
                  disabled={disabled}
                  options={typeOptions()}
                  value={policy.maxType}
                  onChange={(maxType) => change({ maxType })}
                />
              </span>
              <span className="settings-boat-limit">
                <span id={defaultTtlId}>Default auto-stop</span>
                <Select
                  aria-labelledby={defaultTtlId}
                  className="settings-select settings-select--chip"
                  disabled={disabled}
                  options={ttlOptions(policy.defaultTtlMinutes, policy.maxTtlMinutes)}
                  value={String(policy.defaultTtlMinutes)}
                  onChange={(minutes) => change({ defaultTtlMinutes: Number(minutes) })}
                />
              </span>
              <span className="settings-boat-limit">
                <span id={maxTtlId}>Longest auto-stop</span>
                <Select
                  aria-labelledby={maxTtlId}
                  className="settings-select settings-select--chip"
                  disabled={disabled}
                  options={ttlOptions(policy.maxTtlMinutes)}
                  value={String(policy.maxTtlMinutes)}
                  onChange={(minutes) => change({ maxTtlMinutes: Number(minutes) })}
                />
              </span>
            </span>
            <span className="settings-mcp-row__policy-hint">
              PwrAgent refuses a request for a larger machine or a longer auto-stop.
              Agents cannot make a sandbox port public.
            </span>
          </span>
        </div>
      ) : null}
    </>
  );
}
