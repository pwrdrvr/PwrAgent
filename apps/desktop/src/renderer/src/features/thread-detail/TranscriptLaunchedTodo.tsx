import { Fragment, memo, useCallback, useId, useMemo, useState } from "react";
import type { AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DesktopApplicationsSnapshot,
  MarkdownFileViewerContext,
} from "@pwragent/shared/contracts/settings";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { HandoffIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  useThreadLinks,
  type ResolvedThreadLink,
  type ThreadLinkSource,
} from "../../lib/thread-links";
import { RailStatusChip } from "./context-panels/RailStatusChip";
import {
  buildLaunchedThreadPresentation,
  launchedTodoTimestamp,
  type LaunchedThreadRecord,
  type LaunchedTodo,
} from "./launched-todo-entries";
import { ThreadChip } from "./ThreadChip";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

const LAUNCHED_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export type TranscriptLaunchedTodoProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    | "copyText"
    | "openApplication"
    | "openMarkdownFileViewer"
    | "readMarkdownFile"
    | "readThread"
  >;
  fileViewerContext?: MarkdownFileViewerContext;
  skills?: AppServerSkillSummary[];
  threadLinkSource?: ThreadLinkSource;
  record?: LaunchedThreadRecord;
  todo?: LaunchedTodo;
  onOpenStartedThread?: (todo: ThreadTodo) => void;
};

/**
 * Durable transcript card left behind when a child thread is launched from
 * either a to-do card or an agent tool (`handoff_task` /
 * `create_instance_thread`). Shows what was launched, carries a live
 * ThreadChip (hover info card + click to navigate + sidebar highlight), and
 * expands to reveal the launched prompt, plan steps, and any startup failure.
 */
export const TranscriptLaunchedTodo = memo(function TranscriptLaunchedTodo(
  props: TranscriptLaunchedTodoProps,
) {
  const { onOpenStartedThread } = props;
  const record = useMemo<LaunchedThreadRecord | undefined>(() => {
    if (props.record) {
      return props.record;
    }
    if (!props.todo) {
      return undefined;
    }
    return {
      kind: "todo",
      id: props.todo.id,
      launchedAt: launchedTodoTimestamp(props.todo),
      createdAt: props.todo.createdAt,
      todo: props.todo,
    };
  }, [props.record, props.todo]);
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const threadLinks = useThreadLinks();
  const windowOwnerInstanceId = readRendererFederationTarget()?.instanceId;

  const presentation = useMemo(
    () =>
      record
        ? buildLaunchedThreadPresentation({
            record,
            localInstanceId: threadLinks?.localInstanceId,
            windowOwnerInstanceId,
          })
        : undefined,
    [record, threadLinks?.localInstanceId, windowOwnerInstanceId],
  );

  const chipLink = useMemo<ResolvedThreadLink | undefined>(() => {
    if (!presentation) {
      return undefined;
    }
    const { linkRef } = presentation;
    const resolved = threadLinks?.resolve({
      backend: linkRef.backend,
      threadId: linkRef.threadId,
      ...(linkRef.instanceId ? { instanceId: linkRef.instanceId } : {}),
    });
    if (resolved) {
      return resolved.instanceId && !resolved.instanceLabel && linkRef.instanceLabel
        ? { ...resolved, instanceLabel: linkRef.instanceLabel }
        : resolved;
    }
    return {
      backend: linkRef.backend,
      threadId: linkRef.threadId,
      ...(linkRef.instanceId ? { instanceId: linkRef.instanceId } : {}),
      ...(linkRef.instanceLabel ? { instanceLabel: linkRef.instanceLabel } : {}),
      title: linkRef.fallbackLabel,
    };
  }, [presentation, threadLinks]);

  const todoForFallbackOpen = record?.kind === "todo" ? record.todo : undefined;
  const handleOpen = useCallback(
    (link: ResolvedThreadLink): void => {
      if (threadLinks) {
        threadLinks.show(link);
        return;
      }
      if (todoForFallbackOpen) {
        onOpenStartedThread?.(todoForFallbackOpen);
      }
    },
    [onOpenStartedThread, threadLinks, todoForFallbackOpen],
  );

  const formattedTime = useMemo(() => {
    if (!presentation || presentation.launchedAt <= 0) {
      return undefined;
    }
    const iso = new Date(presentation.launchedAt).toISOString();
    return {
      iso,
      label: LAUNCHED_TIME_FORMATTER.format(presentation.launchedAt),
    };
  }, [presentation]);

  if (!record || !presentation || !chipLink) {
    return null;
  }

  const canOpenChip = Boolean(threadLinks || (todoForFallbackOpen && onOpenStartedThread));
  const failurePreview = presentation.setupFailure ?? presentation.turnStartFailure;
  const launchSource = record.kind === "todo" ? "todo" : record.launch.source;

  return (
    <aside
      aria-label={presentation.ariaLabel}
      className="transcript-launched-todo"
      data-expanded={expanded ? "true" : undefined}
      data-launch-source={launchSource}
      data-setup-failed={presentation.statusChipLabel ? "true" : undefined}
      data-todo-id={record.id}
    >
      <header className="transcript-launched-todo__header">
        {presentation.hasExpandableBody ? (
          <button
            type="button"
            className="transcript-launched-todo__toggle"
            aria-controls={detailsId}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <span className="transcript-activity__chevron" aria-hidden="true" />
            <span className="transcript-launched-todo__icon" aria-hidden="true">
              <HandoffIcon size={13} />
            </span>
            <span className="transcript-launched-todo__verb">{presentation.verb}</span>
          </button>
        ) : (
          <span className="transcript-launched-todo__label">
            <span className="transcript-launched-todo__icon" aria-hidden="true">
              <HandoffIcon size={13} />
            </span>
            <span className="transcript-launched-todo__verb">{presentation.verb}</span>
          </span>
        )}
        {canOpenChip ? (
          <ThreadChip
            fallbackLabel={presentation.linkRef.fallbackLabel}
            link={chipLink}
            onOpen={handleOpen}
          />
        ) : (
          <span className="chip thread-chip">
            #{presentation.linkRef.fallbackLabel.replace(/^#/, "")}
          </span>
        )}
        {presentation.statusChipLabel ? (
          <RailStatusChip alert tone="error">
            {presentation.statusChipLabel}
          </RailStatusChip>
        ) : null}
        <span className="transcript-launched-todo__meta">
          <TranscriptCopyButton
            className="transcript-copy-button--activity"
            copiedLabel="Copied launched thread"
            desktopApi={props.desktopApi}
            label="Copy launched thread"
            text={presentation.copyText}
          />
          {formattedTime ? (
            <time
              className="transcript-activity__time tooltip-target"
              dateTime={formattedTime.iso}
              data-tooltip={formattedTime.iso}
            >
              {formattedTime.label}
            </time>
          ) : null}
        </span>
      </header>

      <div className="transcript-launched-todo__summary">
        <p className="transcript-launched-todo__title">{presentation.title}</p>
        {presentation.detail ? (
          <p className="transcript-launched-todo__detail">{presentation.detail}</p>
        ) : null}
        {presentation.facts.length > 0 ? (
          <p className="transcript-launched-todo__facts">
            {presentation.facts.map((fact, index) => (
              <Fragment key={`${index}:${fact}`}>
                {index > 0 ? (
                  <span className="transcript-launched-todo__fact-sep" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                <span>{fact}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
        {presentation.resultNotice ? (
          <p className="transcript-launched-todo__notice">{presentation.resultNotice}</p>
        ) : null}
        {failurePreview && !expanded ? (
          <p className="transcript-launched-todo__error-preview">
            {failurePreview}
          </p>
        ) : null}
      </div>

      {presentation.hasExpandableBody && expanded ? (
        <div id={detailsId} className="transcript-launched-todo__body">
          {presentation.setupFailure ? (
            <section className="transcript-launched-todo__section">
              <p className="transcript-launched-todo__section-label">
                Environment setup failed
              </p>
              <p className="transcript-launched-todo__error-text">
                {presentation.setupFailure}
              </p>
            </section>
          ) : null}
          {presentation.turnStartFailure ? (
            <section className="transcript-launched-todo__section">
              <p className="transcript-launched-todo__section-label">
                Initial turn failed
              </p>
              <p className="transcript-launched-todo__error-text">
                {presentation.turnStartFailure}
              </p>
            </section>
          ) : null}
          {presentation.steps.length > 0 ? (
            <section className="transcript-launched-todo__section">
              <p className="transcript-launched-todo__section-label">Plan steps</p>
              <ul className="transcript-launched-todo__steps">
                {presentation.steps.map((step) => (
                  <li key={step.id}>{step.text}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {presentation.prompt ? (
            <section className="transcript-launched-todo__section">
              <p className="transcript-launched-todo__section-label">Prompt</p>
              <ThreadMarkdown
                applications={props.applications}
                desktopApi={props.desktopApi}
                fileViewerContext={props.fileViewerContext}
                skills={props.skills}
                text={presentation.prompt}
                threadLinkSource={props.threadLinkSource}
                variant="summary"
              />
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
});
