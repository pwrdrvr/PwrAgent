import { useEffect, useId, useState } from "react";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { AppUpdateNoticeAgent } from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatMessagingPlatformName } from "../../lib/messaging-platform-branding";
import { SettingsField } from "./SettingsLayout";

function conversationSummary({ enabled, conversations }: AppUpdateNoticeAgent): string {
  if (!conversations.length) {
    return enabled ? "No conversation bound. Nothing is sent until one is." : "No conversation bound";
  }
  const names = conversations.slice(0, 2).map(({ platform, name }) => `${formatMessagingPlatformName(platform)} ${name}`);
  const count = conversations.length;
  if (count > names.length) names.push(`+${count - names.length} more`);
  return `${count} ${count === 1 ? "conversation" : "conversations"} · ${names.join(", ")}`;
}

export function AgentUpdateNoticesField({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [agents, setAgents] = useState<AppUpdateNoticeAgent[]>();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  useEffect(() => {
    if (!desktopApi?.listAppUpdateNoticeAgents) return;
    let generation = 0;
    function reload() {
      const revision = ++generation;
      void desktopApi?.listAppUpdateNoticeAgents?.().then((next) => {
        if (revision !== generation) return;
        setAgents(next);
        setLoadError(false);
      }, () => {
        if (revision === generation) setLoadError(true);
      });
    }
    reload();
    const offBindings = desktopApi.onMessagingBindingsChanged?.(reload);
    const offAgent = desktopApi.onAgentEvent?.(({ notification, federationTarget }) => {
      if (federationTarget?.scope === "remote") return;
      if (notification.method === "thread/agent/updated" || notification.method === "thread/archived"
        || notification.method === "thread/unarchived") reload();
    });
    return () => {
      generation += 1;
      offBindings?.();
      offAgent?.();
    };
  }, [desktopApi]);

  if (!desktopApi?.listAppUpdateNoticeAgents || !desktopApi.setAppUpdateNoticeAgent) return null;
  const save = async (agent: AppUpdateNoticeAgent, enabled: boolean) => {
    const key = buildThreadIdentityKey(agent.backend, agent.threadId);
    setPending((current) => new Set(current).add(key));
    setSaveError(undefined);
    try {
      const saved = await desktopApi.setAppUpdateNoticeAgent?.({ backend: agent.backend, threadId: agent.threadId, enabled });
      if (saved !== enabled) throw new Error("The Agent is no longer available.");
      setAgents((current) => current?.map((row) =>
        row.backend === agent.backend && row.threadId === agent.threadId ? { ...row, enabled } : row
      ));
    } catch {
      setSaveError(`Could not save update notices for ${agent.name}.`);
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return <SettingsField
    label="Notify Agents"
    sub="Post to these Agents' messaging conversations when an update is available and when it is ready. Installing still happens on this machine."
    error={loadError ? "Could not load Agents." : saveError}
    control={
      <fieldset className="settings-update-notices" aria-label="Agents to notify about updates">
        {agents?.length ? agents.map((agent) =>
          <AgentNoticeRow
            key={buildThreadIdentityKey(agent.backend, agent.threadId)}
            agent={agent}
            pending={pending.has(buildThreadIdentityKey(agent.backend, agent.threadId))}
            onChange={(enabled) => void save(agent, enabled)}
          />
        ) : !loadError && <span className="settings-field__help">
          {agents ? "No Agents yet. Use Mark as Agent in a thread's Thread Info panel, then choose it here." : "Loading Agents…"}
        </span>}
      </fieldset>
    }
  />;
}

function AgentNoticeRow(props: { agent: AppUpdateNoticeAgent; pending: boolean; onChange(enabled: boolean): void }) {
  const label = useId();
  const description = useId();
  return <label className="settings-update-notices__row">
    <input
      type="checkbox"
      className="settings-thread-management__checkbox-input"
      checked={props.agent.enabled}
      aria-labelledby={label}
      aria-describedby={description}
      aria-disabled={props.pending || undefined}
      onClick={(event) => { if (props.pending) event.preventDefault(); }}
      onChange={(event) => { if (!props.pending) props.onChange(event.currentTarget.checked); }}
    />
    <span className={`settings-thread-management__checkbox${props.agent.enabled ? " is-checked" : ""}`} aria-hidden="true" />
    <span className="settings-update-notices__text">
      <span id={label}>{props.agent.name}</span>
      <span id={description} className="settings-field__help">{conversationSummary(props.agent)}</span>
    </span>
  </label>;
}
