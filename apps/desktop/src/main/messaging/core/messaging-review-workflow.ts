import path from "node:path";
import { findThreadForBinding } from "./messaging-callback-helpers";
import { asPlainRecord } from "./messaging-backend-event-helpers";
import type { ReviewAfterAction, ReviewRunMode } from "@pwragent/shared";
import { buildMessagingModelMenuActions } from "./messaging-model-menu";
import { buildReviewBranchOptions, findPreferredReviewWorkspaceCwd, findPrimaryReviewWorkspaceCwd } from "@pwragent/shared";
import type { AppServerBackendKind, AppServerReviewTarget, ModelSettingsRecent, NavigationDirectorySummary, NavigationThreadSummary, ThreadExecutionMode } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent, MessagingInboundEvent, MessagingInboundTextEvent, MessagingJsonValue, MessagingPendingIntentRecord, MessagingReviewIntent, MessagingSurfaceAction, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { applyActionCapabilityLimits } from "@pwragent/messaging-interface";
import { buildConfirmationIntent, buildErrorIntent, buildReviewStartConfirmationIntent, messagingReviewStartTarget } from "./messaging-renderer.js";
import { isMessagingThreadContext, type MessagingNavigationContext } from "./messaging-thread-state.js";
import { resolveExecutionModeForThread, turnSettingsForThread } from "./messaging-inbound-helpers";
import type { MessagingReviewContext } from "./messaging-review-context";

export class MessagingReviewWorkflow {
  constructor(private readonly context: MessagingReviewContext) {}

  async presentReviewPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    // findPreferredReviewWorkspaceCwd and buildReviewBranchOptions below read
    // thread.gitWorkingState to choose a workspace and infer a base branch, so
    // this picker cannot race the background refresh.
    const navigation = await this.context.host().readBoundWorkspaceContext(binding);
    const thread = findThreadForBinding(navigation, binding);
    const workspaces = (thread?.linkedDirectories ?? [])
      .map((directory) => ({
        cwd: directory.worktreePath ?? directory.path,
        label: directory.label,
        repositoryPath: directory.path,
      }))
      .filter(
        (workspace): workspace is {
          cwd: string;
          label: string;
          repositoryPath: string;
        } =>
          Boolean(workspace.cwd),
      );
    const preferredWorkspaceCwd = findPreferredReviewWorkspaceCwd(thread);
    const selectedWorkspace = workspaces.find(
      (workspace) => workspace.cwd.trim() === preferredWorkspaceCwd,
    ) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    const defaultRepositoryPath =
      selectedWorkspace?.repositoryPath
      ?? workspaces[0]?.repositoryPath;
    const directory = (navigation.workspaceDirectories ?? []).find((candidate) =>
      reviewWorkspaceMatches(candidate.path, defaultRepositoryPath),
    );
    const workspaceThread = reviewThreadForWorkspace(
      thread,
      selectedWorkspace?.cwd,
    );
    const target: AppServerReviewTarget = {
      type: "baseBranch",
      branch:
        buildReviewBranchOptions({ directory, thread: workspaceThread })[0]
        ?? "main",
    };
    const intent = this.buildReviewIntent({
      binding,
      navigation,
      phase: "summary",
      target,
      reviewerBackends: await this.listReviewerBackends(),
      ...(selectedWorkspace
        ? {
            cwd: selectedWorkspace.cwd,
            repositoryPath: selectedWorkspace.repositoryPath,
          }
        : {}),
    });
    const pending = await this.context.host().storePendingIntent(intent, binding, event);
    const result = await this.context.host().deliver(intent, binding, event);
    await this.context.store.upsertPendingIntent({
      ...pending,
      surface: result.surface ?? pending.surface,
    });
  }

  buildReviewIntent(params: {
    binding: MessagingBindingRecord;
    navigation: MessagingNavigationContext;
    phase: MessagingReviewIntent["review"]["phase"];
    runMode?: ReviewRunMode;
    afterReview?: ReviewAfterAction;
    cwd?: string;
    repositoryPath?: string;
    workspacePageIndex?: number;
    target?: AppServerReviewTarget;
    reviewer?: ModelSettingsRecent;
    reviewerBackends?: MessagingReviewIntent["review"]["reviewerBackends"];
    modelMenuValue?: MessagingJsonValue;
    id?: string;
    createdAt?: number;
    targetSurface?: MessagingSurfaceRef;
  }): MessagingReviewIntent {
    const thread = findThreadForBinding(params.navigation, params.binding);
    const linkedWorkspaces = (thread?.linkedDirectories ?? []).flatMap((directory) => {
      const cwd = directory.worktreePath ?? directory.path;
      return cwd
        ? [{
            cwd,
            label: directory.label,
            repositoryPath: directory.path,
          }]
        : [];
    });
    const directory = (isMessagingThreadContext(params.navigation) ? params.navigation.workspaceDirectories ?? [] : params.navigation.directories).find((candidate) =>
      reviewWorkspaceMatches(
        candidate.path,
        params.repositoryPath
        ?? params.cwd
        ?? linkedWorkspaces[0]?.repositoryPath,
      ),
    );
    const selectedWorkspace = linkedWorkspaces.find(
      (workspace) => workspace.cwd === params.cwd,
    );
    const workspaceThread = reviewThreadForWorkspace(thread, params.cwd);
    const defaultBaseBranch =
      buildReviewBranchOptions({ directory, thread: workspaceThread })[0]
      ?? "main";
    const target =
      params.target
      ?? {
        type: "baseBranch" as const,
        branch: defaultBaseBranch,
      };
    const reviewerBackends = params.reviewerBackends ?? [];
    // No advertised review runners means this instance predates reviewer
    // overrides; the Reviewer button stays off rather than offering a choice
    // that cannot land.
    const reviewerOverridesSupported = reviewerBackends.some((entry) => entry.capabilities?.reviewRunner === true);
    const reviewerBackendKind = params.reviewer?.backend ?? params.binding.backend;
    const reviewerEntry = reviewerBackends.find(
      (entry) => entry.backend === reviewerBackendKind,
    );
    // The inherited case must report the same settings the non-override
    // submit path resolves, which falls back to the binding's own preferences
    // when the thread carries none — reading `thread` alone would show
    // "provider default" and then run with the binding's model.
    const inheritedSettings = params.reviewer
      ? undefined
      : turnSettingsForBinding(params.binding, params.navigation);
    // An un-picked model/effort stays blank rather than guessing the
    // provider's first entry — the review resolves those against the picked
    // provider's own defaults.
    const reviewerModelId = params.reviewer?.model ?? inheritedSettings?.model;
    const reviewerEffort =
      params.reviewer?.reasoningEffort ?? inheritedSettings?.reasoningEffort;
    const reviewerModelEntry = reviewerEntry?.models.find(
      (model) => model.id === reviewerModelId,
    );
    const reviewerSummaryLabel = [
      reviewerEntry?.label ?? reviewerBackendKind,
      reviewerModelId ?? "provider default",
      reviewerEffort,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");

    const owner = reviewerBackends.find((entry) => entry.backend === params.binding.backend);
    const modeSupported = owner?.capabilities?.reviewRunMode === true;
    const autoFixSupported = owner?.capabilities?.reviewAutoFix === true;
    const afterReview = params.afterReview ?? (autoFixSupported ? "auto-fix" : undefined);
    const autoFixUnavailable = !autoFixSupported && afterReview === "auto-fix"
      ? "This owner no longer supports review Auto-fix. Update that PwrAgent instance before starting this review."
      : undefined;
    const primaryCwd = thread ? findPrimaryReviewWorkspaceCwd(thread) : undefined;
    const managedReason = reviewerBackendKind !== params.binding.backend
      ? "PwrAgent Sub Agent is required for a different review provider."
      : params.binding.backend.startsWith("acp:")
        ? "PwrAgent Sub Agent is required for ACP reviews."
        : params.cwd && primaryCwd && !reviewWorkspaceMatches(params.cwd, primaryCwd)
          ? "PwrAgent Sub Agent is required for a secondary workspace."
          : undefined;
    const runMode = !modeSupported
      ? params.runMode
      : managedReason ? "pwragent-sub-agent" : params.runMode ?? "codex-sub-agent";
    const modeUnavailable = !modeSupported && runMode !== undefined
      ? "This owner no longer supports explicit review modes. Update that PwrAgent instance before starting this review."
      : undefined;
    const modeOptions: { label: string; value: ReviewRunMode; supported: boolean }[] = [
      { label: "Codex Sub Agent", value: "codex-sub-agent", supported: owner?.capabilities?.reviewCodexSubAgent === true && !managedReason },
      { label: "PwrAgent Sub Agent", value: "pwragent-sub-agent", supported: reviewerEntry?.capabilities?.reviewRunner === true },
    ];
    const modeLabel = modeOptions.find((option) => option.value === runMode)?.label ?? "Owner default";

    let title = "Review";
    let body: string;
    let allowFreeform = false;
    let actions: MessagingSurfaceAction[] = [];
    const backAction: MessagingSurfaceAction = {
      id: "review:back",
      label: "Back",
      fallbackText: "back",
      priority: 1,
    };
    const cancelAction: MessagingSurfaceAction = {
      id: "review:cancel",
      label: "Cancel",
      style: "danger",
      fallbackText: "cancel",
      priority: 2,
    };

    if (params.phase === "summary") {
      const projectLabel =
        selectedWorkspace?.label
        ?? (
          linkedWorkspaces.length > 1
            ? "[needs selection]"
            : linkedWorkspaces[0]?.label ?? "Thread workspace"
        );
      const summaryLines = [
        `Project: ${projectLabel}`,
        `Review: ${formatMessagingReviewScope(target)}`,
      ];
      if (target.type === "baseBranch") {
        summaryLines.push(`Base Branch: ${target.branch}`);
      } else if (target.type === "commit") {
        summaryLines.push(
          `Commit: ${target.title?.trim() || target.sha || "[needs selection]"}`,
        );
      } else if (target.type === "custom") {
        summaryLines.push(`Instructions: ${target.instructions}`);
      }
      if (reviewerOverridesSupported) {
        summaryLines.push(
          `Reviewer: ${reviewerSummaryLabel}${params.reviewer ? "" : " (thread default)"}`,
        );
      }
      if (runMode) summaryLines.push(`Mode: ${modeLabel}`);
      if (modeUnavailable) summaryLines.push(modeUnavailable);
      if (modeSupported && managedReason) summaryLines.push(managedReason);
      if (autoFixSupported) summaryLines.push(`Auto-fix findings: ${afterReview === "auto-fix" ? "On" : "Off"}`);
      if (autoFixUnavailable) summaryLines.push(autoFixUnavailable);
      body = summaryLines.join("\n");
      actions = [
        ...(linkedWorkspaces.length > 1
          ? [{
              id: "review:summary:workspace",
              label: "Project",
              fallbackText: "project",
              priority: 10,
            }]
          : []),
        {
          id: "review:summary:target",
          label: "Review Scope",
          fallbackText: "review scope",
          priority: 11,
        },
        ...(target.type === "baseBranch"
          ? [{
              id: "review:summary:base-branch",
              label: "Base Branch",
              fallbackText: "base branch",
              priority: 12,
            }]
          : target.type === "commit"
            ? [{
                id: "review:summary:commit",
                label: "Commit",
                fallbackText: "commit",
                priority: 12,
              }]
            : target.type === "custom"
              ? [{
                  id: "review:summary:custom",
                  label: "Instructions",
                  fallbackText: "instructions",
                  priority: 12,
                }]
              : []),
        ...(reviewerOverridesSupported
          ? [{
              id: "review:summary:reviewer",
              label: "Reviewer",
              fallbackText: "reviewer",
              priority: 13,
            }]
          : []),
        ...(modeSupported ? [{
          id: "review:summary:mode", label: "Review Mode", fallbackText: "review mode", priority: 3,
        }] : []),
        ...(autoFixSupported ? [{
          id: "review:summary:auto-fix",
          label: `Auto-fix findings: ${afterReview === "auto-fix" ? "On" : "Off"}`,
          fallbackText: "auto-fix findings",
          priority: 4,
        }] : []),
        {
          id: "review:summary:start",
          label: "Start Review",
          style: "primary",
          fallbackText: "start review",
          priority: 0,
        },
        cancelAction,
      ];
    } else if (params.phase === "run_mode") {
      title = "Review mode";
      body = modeUnavailable ?? managedReason ?? "Choose how to run this review.";
      actions = [
        ...modeOptions.filter((option) => modeSupported && option.supported).map((option) => ({
          id: `review:mode:${option.value}`,
          label: option.label,
          fallbackText: option.label,
          value: { runMode: option.value },
          priority: 0,
        })),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "workspace") {
      const page = paginateReviewWorkspaces({
        itemCount: linkedWorkspaces.length,
        maxActions: this.context.capabilityProfile.actions?.maxActions,
        pageIndex: params.workspacePageIndex,
      });
      title = "Review project";
      body = [
        "Choose the linked project to review.",
        page.totalPages > 1
          ? `Page ${page.pageIndex + 1}/${page.totalPages}.`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      actions = [
        ...linkedWorkspaces
          .slice(page.startIndex, page.endIndex)
          .map((workspace, index) => ({
            id: `review:workspace:${page.startIndex + index}`,
            label: workspace.label,
            fallbackText: workspace.cwd,
            priority: 10 + index,
            value: {
              cwd: workspace.cwd,
              repositoryPath: workspace.repositoryPath,
            },
          })),
        ...(page.pageIndex > 0
          ? [{
              id: "review:workspace:previous",
              label: "Previous",
              fallbackText: "previous",
              priority: 3,
              value: { pageIndex: page.pageIndex - 1 },
            }]
          : []),
        ...(page.pageIndex < page.totalPages - 1
          ? [{
              id: "review:workspace:next",
              label: "Next",
              fallbackText: "next",
              priority: 4,
              value: { pageIndex: page.pageIndex + 1 },
            }]
          : []),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "target") {
      title = "Review scope";
      body = "Choose what PwrAgent should review.";
      actions = [
        {
          id: "review:target:base-branch",
          label: "Base branch",
          description: "Compare this branch with a base branch",
          fallbackText: "base branch",
          value: { targetType: "baseBranch" },
        },
        {
          id: "review:target:current-changes",
          label: "Current changes",
          description: "Review staged, unstaged, and untracked files",
          fallbackText: "current changes",
          value: { targetType: "uncommittedChanges" },
        },
        {
          id: "review:target:commit",
          label: "Commit",
          description: "Review one commit by SHA",
          fallbackText: "commit",
          value: { targetType: "commit" },
        },
        {
          id: "review:target:custom",
          label: "Custom",
          description: "Review using custom instructions",
          fallbackText: "custom",
          value: { targetType: "custom" },
        },
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "base_branch") {
      title = "Base branch";
      body = "Choose a suggested base branch or reply with any branch name.";
      allowFreeform = true;
      actions = [
        ...messagingReviewBranchOptions({
          directory,
          thread: workspaceThread,
        }).map((branch, index) => ({
          id: `review:base-branch:${index}`,
          label: branch,
          fallbackText: branch,
          priority: 10 + index,
          value: { branch },
        })),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "commit") {
      title = "Commit";
      body = "Choose a recent commit or reply with a commit SHA.";
      allowFreeform = true;
      actions = [
        ...(directory?.gitStatus?.recentCommits ?? []).map((commit, index) => ({
          id: `review:commit:${index}`,
          label: `${commit.shortSha} ${commit.subject}`,
          fallbackText: commit.sha,
          priority: 10 + index,
          value: {
            sha: commit.sha,
            title: commit.subject,
          },
        })),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "custom") {
      title = "Custom review";
      body = "Reply with the review instructions.";
      allowFreeform = true;
      actions = [backAction, cancelAction];
    } else if (params.phase === "reviewer_provider") {
      title = "Review provider";
      body = [
        "Choose the provider that runs this review.",
        "It applies to this review only — the thread keeps its own settings.",
      ].join("\n");
      actions = [
        ...reviewerBackends.flatMap((entry, index) => entry.capabilities?.reviewRunner !== true ? [] : [{
          id: `review:reviewer:provider:${index}`,
          label: entry.label,
          fallbackText: entry.backend,
          priority: 10 + index,
          value: { backend: entry.backend },
        }]),
        // Priority sits with Back/Cancel, not with the options: truncation
        // drops the highest priority number first, and the escape hatch is
        // the last thing that should go when a profile caps actions.
        ...(params.reviewer
          ? [{
              id: "review:reviewer:inherit",
              label: "Use Thread Default",
              fallbackText: "use thread default",
              priority: 3,
            }]
          : []),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "reviewer_model") {
      const models = reviewerEntry?.models ?? [];
      title = "Review model";
      body = `Choose the model ${reviewerEntry?.label ?? reviewerBackendKind} should review with.`;
      actions = buildMessagingModelMenuActions({
        kind: reviewerBackendKind,
        models,
        currentModelId: reviewerModelId,
        menuValue: params.modelMenuValue,
        menuActionId: "review:reviewer:models",
        selectActionId: (model) => `review:reviewer:model:${models.findIndex((candidate) => candidate.id === model.id)}`,
        capabilityProfile: this.context.capabilityProfile,
        backAction,
        footerActions: [
          {
            id: "review:reviewer:model:default",
            label: "Provider Default",
            fallbackText: "provider default",
            priority: 3,
          },
          cancelAction,
        ],
      });
    } else if (params.phase === "reviewer_effort") {
      const efforts = reviewerModelEntry?.reasoningEfforts ?? [];
      title = "Review reasoning";
      body = `Choose the reasoning effort for ${reviewerModelEntry?.label ?? reviewerModelId ?? "this model"}.`;
      actions = [
        ...efforts.map((effort, index) => ({
          id: `review:reviewer:effort:${index}`,
          label: effort,
          fallbackText: effort,
          priority: 10 + index,
          value: { reasoningEffort: effort },
        })),
        {
          id: "review:reviewer:effort:default",
          label: "Provider Default",
          fallbackText: "provider default",
          priority: 3,
        },
        backAction,
        cancelAction,
      ];
    } else {
      title = "Review submitted";
      body = "The review request was submitted.";
    }

    actions = applyActionCapabilityLimits(actions, this.context.capabilityProfile);
    return {
      id: params.id ?? this.context.host().newIntentId("review"),
      kind: "review",
      bindingId: params.binding.id,
      createdAt: params.createdAt ?? this.context.now(),
      title,
      body,
      actions,
      allowFreeform,
      fallbackText: allowFreeform
        ? `${body} Reply with text or tap an option.`
        : body,
      review: {
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        phase: params.phase,
        ...(runMode ? { runMode } : {}),
        ...(afterReview ? { afterReview } : {}),
        ...(params.reviewer ? { reviewer: params.reviewer } : {}),
        ...(reviewerBackends.length > 0 ? { reviewerBackends } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.repositoryPath
          ? { repositoryPath: params.repositoryPath }
          : {}),
        workspaceSelectionRequired: linkedWorkspaces.length > 1,
        ...(params.workspacePageIndex !== undefined
          ? { workspacePageIndex: params.workspacePageIndex }
          : {}),
        targetType: target.type,
        target,
      },
      ...(params.targetSurface
        ? {
            targetSurface: params.targetSurface,
            delivery: {
              mode: "update",
              replaceMarkup: true,
              fallback: "present_new",
            },
          }
        : {}),
    };
  }

  async handleReviewTextAnswer(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundTextEvent,
  ): Promise<boolean> {
    if (pendingIntent.intent.kind !== "review") {
      return false;
    }

    const value = event.text.trim();
    if (!pendingIntent.intent.allowFreeform || !value) {
      return false;
    }

    let target: AppServerReviewTarget | undefined;
    if (pendingIntent.intent.review.phase === "base_branch") {
      target = { type: "baseBranch", branch: value };
    } else if (pendingIntent.intent.review.phase === "commit") {
      const [sha, ...titleParts] = value.split(/\s+/);
      if (sha) {
        target = {
          type: "commit",
          sha,
          title: titleParts.length > 0 ? titleParts.join(" ") : null,
        };
      }
    } else if (pendingIntent.intent.review.phase === "custom") {
      target = { type: "custom", instructions: value };
    }

    if (!target) {
      return false;
    }

    await this.updateReviewPendingIntent(pendingIntent, event, {
      phase: "summary",
      target,
    });
    return true;
  }

  async handleReviewAction(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
    action: MessagingSurfaceAction,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "review") {
      return;
    }

    const value = asPlainRecord(action.value);
    const phase = pendingIntent.intent.review.phase;
    if (action.id === "review:cancel") {
      await this.cancelReviewPendingIntent(pendingIntent, event);
      return;
    }
    if (action.id === "review:back") {
      await this.updateReviewPendingIntent(pendingIntent, event, {
        phase: "summary",
      });
      return;
    }

    if (phase === "summary") {
      if (action.id === "review:summary:workspace") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "workspace",
          workspacePageIndex: 0,
        });
      } else if (action.id === "review:summary:target") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "target",
        });
      } else if (action.id === "review:summary:base-branch") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "base_branch",
        });
      } else if (action.id === "review:summary:commit") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "commit",
        });
      } else if (action.id === "review:summary:custom") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "custom",
        });
      } else if (action.id === "review:summary:mode") {
        await this.updateReviewPendingIntent(pendingIntent, event, { phase: "run_mode" });
      } else if (action.id === "review:summary:auto-fix") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          afterReview: pendingIntent.intent.review.afterReview === "auto-fix" ? "wait" : "auto-fix",
        });
      } else if (action.id === "review:summary:reviewer") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "reviewer_provider",
        });
      } else if (action.id === "review:summary:start") {
        if (
          pendingIntent.intent.review.workspaceSelectionRequired
          && !pendingIntent.intent.review.cwd
        ) {
          await this.updateReviewPendingIntent(pendingIntent, event, {
            phase: "workspace",
            workspacePageIndex: 0,
          });
          return;
        }
        const target = pendingIntent.intent.review.target;
        if (!target) {
          await this.updateReviewPendingIntent(pendingIntent, event, {
            phase: "target",
          });
          return;
        }
        await this.submitMessagingReviewFromPending(
          pendingIntent,
          event,
          target,
        );
      }
      return;
    }

    if (phase === "run_mode") {
      const runMode = value?.runMode;
      if (runMode === "codex-sub-agent" || runMode === "pwragent-sub-agent") {
        await this.updateReviewPendingIntent(pendingIntent, event, { phase: "summary", runMode });
      }
      return;
    }

    if (
      phase === "reviewer_provider"
      || phase === "reviewer_model"
      || phase === "reviewer_effort"
    ) {
      const current = pendingIntent.intent.review.reviewer;
      if (action.id === "review:reviewer:inherit") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          clearReviewer: true,
        });
        return;
      }
      if (phase === "reviewer_provider") {
        const backend = typeof value?.backend === "string"
          ? (value.backend as AppServerBackendKind)
          : undefined;
        if (!backend) {
          return;
        }
        // Switching provider drops the model and effort: they belong to the
        // previous provider's catalog and cannot carry across.
        const entry = pendingIntent.intent.review.reviewerBackends?.find(
          (candidate) => candidate.backend === backend,
        );
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: entry?.models.length ? "reviewer_model" : "summary",
          reviewer: { backend },
        });
        return;
      }
      if (!current) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "reviewer_provider",
        });
        return;
      }
      if (phase === "reviewer_model") {
        if (action.id.startsWith("review:reviewer:models:")) {
          await this.updateReviewPendingIntent(pendingIntent, event, {
            phase: "reviewer_model",
            modelMenuValue: action.value,
          });
          return;
        }
        const model = typeof value?.model === "string" ? value.model : undefined;
        const next: ModelSettingsRecent = {
          backend: current.backend,
          ...(model ? { model } : {}),
        };
        const entry = pendingIntent.intent.review.reviewerBackends?.find(
          (candidate) => candidate.backend === current.backend,
        );
        const efforts = model
          ? entry?.models.find((candidate) => candidate.id === model)
              ?.reasoningEfforts ?? []
          : [];
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: efforts.length > 0 ? "reviewer_effort" : "summary",
          reviewer: next,
        });
        return;
      }
      const reasoningEffort =
        typeof value?.reasoningEffort === "string"
          ? value.reasoningEffort
          : undefined;
      await this.updateReviewPendingIntent(pendingIntent, event, {
        phase: "summary",
        reviewer: {
          ...current,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      });
      return;
    }

    if (phase === "workspace") {
      const workspacePageIndex =
        typeof value?.pageIndex === "number" && Number.isFinite(value.pageIndex)
          ? Math.max(0, Math.trunc(value.pageIndex))
          : undefined;
      if (
        (
          action.id === "review:workspace:previous"
          || action.id === "review:workspace:next"
        )
        && workspacePageIndex !== undefined
      ) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "workspace",
          workspacePageIndex,
        });
        return;
      }
      const cwd = typeof value?.cwd === "string" ? value.cwd.trim() : "";
      const repositoryPath =
        typeof value?.repositoryPath === "string"
          ? value.repositoryPath.trim()
          : "";
      if (cwd) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          cwd,
          ...(repositoryPath ? { repositoryPath } : {}),
          resetRepositoryTarget: true,
          resetBaseBranch: true,
        });
      }
      return;
    }

    if (phase === "target") {
      const targetType =
        typeof value?.targetType === "string" ? value.targetType : undefined;
      if (targetType === "uncommittedChanges") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          target: { type: "uncommittedChanges" },
        });
      } else if (targetType === "baseBranch") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          forceBaseBranch: true,
          resetBaseBranch: true,
        });
      } else if (targetType === "commit") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "commit",
        });
      } else if (targetType === "custom") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "custom",
        });
      }
      return;
    }

    if (phase === "base_branch") {
      const branch = typeof value?.branch === "string" ? value.branch.trim() : "";
      if (branch) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          target: { type: "baseBranch", branch },
        });
      }
      return;
    }

    if (phase === "commit") {
      const sha = typeof value?.sha === "string" ? value.sha.trim() : "";
      const title = typeof value?.title === "string" ? value.title : null;
      if (sha) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          target: { type: "commit", sha, title },
        });
      }
    }
  }

  async updateReviewPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
    review: {
      phase: MessagingReviewIntent["review"]["phase"];
      runMode?: ReviewRunMode;
      afterReview?: ReviewAfterAction;
      cwd?: string;
      repositoryPath?: string;
      workspacePageIndex?: number;
      target?: AppServerReviewTarget;
      reviewer?: ModelSettingsRecent;
      modelMenuValue?: MessagingJsonValue;
      clearReviewer?: boolean;
      forceBaseBranch?: boolean;
      resetRepositoryTarget?: boolean;
      resetBaseBranch?: boolean;
    },
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "review") {
      return;
    }
    const binding = pendingIntent.bindingId
      ? await this.context.store.getBinding(pendingIntent.bindingId)
      : undefined;
    if (!binding || binding.revokedAt) {
      await this.context.store.deletePendingIntent(pendingIntent.id);
      return;
    }

    // buildReviewBranchOptions below infers the base branch from
    // thread.gitWorkingState, so this callback awaits working state for the
    // same reason presentReviewPicker does.
    const navigation = await this.context.host().readBoundWorkspaceContext(binding);
    const targetSurface = pendingIntent.surface ?? (
      event.kind === "callback" ? event.interaction : undefined
    );
    const cwd = review.cwd ?? pendingIntent.intent.review.cwd;
    const repositoryPath =
      review.repositoryPath
      ?? pendingIntent.intent.review.repositoryPath;
    let target = review.target ?? pendingIntent.intent.review.target;
    if (review.resetRepositoryTarget && target?.type === "commit") {
      target = undefined;
    }
    if (
      review.resetBaseBranch
      && (
        review.forceBaseBranch
        || !target
        || target.type === "baseBranch"
      )
    ) {
      const thread = findThreadForBinding(navigation, binding);
      const workspaceThread = reviewThreadForWorkspace(thread, cwd);
      const directory = (navigation.workspaceDirectories ?? []).find((candidate) =>
        reviewWorkspaceMatches(
          candidate.path,
          repositoryPath ?? cwd,
        ),
      );
      target = {
        type: "baseBranch",
        branch:
          buildReviewBranchOptions({ directory, thread: workspaceThread })[0]
          ?? "main",
      };
    }
    const intent = this.buildReviewIntent({
      binding,
      navigation,
      phase: review.phase,
      runMode: review.runMode ?? pendingIntent.intent.review.runMode,
      afterReview: review.afterReview ?? pendingIntent.intent.review.afterReview,
      cwd,
      repositoryPath,
      workspacePageIndex: review.workspacePageIndex,
      target,
      ...(review.clearReviewer
        ? {}
        : {
            reviewer: review.reviewer ?? pendingIntent.intent.review.reviewer,
          }),
      reviewerBackends: await this.listReviewerBackends(),
      modelMenuValue: review.modelMenuValue,
      id: pendingIntent.intent.id,
      createdAt: pendingIntent.intent.createdAt,
      targetSurface,
    });
    const result = await this.context.host().deliver(intent, binding, event);
    await this.context.store.upsertPendingIntent({
      ...pendingIntent,
      intent,
      surface: result.surface ?? pendingIntent.surface,
    });
  }

  async cancelReviewPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const binding = pendingIntent.bindingId
      ? await this.context.store.getBinding(pendingIntent.bindingId)
      : undefined;
    await this.context.store.deletePendingIntent(pendingIntent.id);
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("review-cancelled"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "Review cancelled",
        body: "No review was started.",
        targetSurface: pendingIntent.surface ?? event.interaction,
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "present_new",
        },
      }),
      binding && !binding.revokedAt ? binding : undefined,
      event,
    );
  }

  async submitMessagingReviewFromPending(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
    target: AppServerReviewTarget,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "review") {
      return;
    }
    const binding = pendingIntent.bindingId
      ? await this.context.store.getBinding(pendingIntent.bindingId)
      : undefined;
    if (!binding || binding.revokedAt) {
      await this.context.store.deletePendingIntent(pendingIntent.id);
      return;
    }

    const reviewer = pendingIntent.intent.review.reviewer;
    const reviewerBackends = pendingIntent.intent.review.reviewerBackends;
    const reviewerBackend = reviewer?.backend ?? binding.backend;
    await this.submitMessagingReview({
      binding,
      event,
      target,
      cwd: pendingIntent.intent.review.cwd,
      runMode: pendingIntent.intent.review.runMode,
      afterReview: pendingIntent.intent.review.afterReview,
      reviewerLabel: reviewerBackends?.find(
        (candidate) => candidate.backend === reviewerBackend,
      )?.label,
      ...(reviewer
        ? {
            reviewBackend: reviewer.backend,
            ...(reviewer.model ? { model: reviewer.model } : {}),
            ...(reviewer.reasoningEffort
              ? { reasoningEffort: reviewer.reasoningEffort }
              : {}),
          }
        : {}),
      targetSurface: pendingIntent.surface,
      pendingIntentId: pendingIntent.id,
    });
  }

  async submitMessagingReview(params: {
    binding: MessagingBindingRecord;
    event: MessagingInboundEvent;
    target: AppServerReviewTarget;
    cwd?: string;
    runMode?: ReviewRunMode;
    afterReview?: ReviewAfterAction;
    /** Reviewer override typed on the command; absent means inherit. */
    reviewBackend?: AppServerBackendKind;
    /** Human-facing reviewer label resolved by the picker, when known. */
    reviewerLabel?: string;
    model?: string;
    reasoningEffort?: string;
    targetSurface?: MessagingSurfaceRef;
    pendingIntentId?: string;
  }): Promise<void> {
    const submitReview = this.context.backend.submitReview?.bind(
      this.context.backend,
    );
    if (!submitReview || !await this.reviewSupportedForBinding(params.binding)) {
      await this.deliverReviewUnsupported(params.binding, params.event);
      return;
    }

    try {
      const owner = await this.context.host().getBackendSummary(params.binding.backend);
      if (params.runMode !== undefined) {
        if (owner?.capabilities.reviewRunMode !== true) {
          throw new Error("This owner no longer supports explicit review modes. Update that PwrAgent instance before starting this review.");
        }
      }
      const afterReview = params.afterReview ?? (owner?.capabilities.reviewAutoFix === true ? "auto-fix" : undefined);
      if (afterReview === "auto-fix" && owner?.capabilities.reviewAutoFix !== true) {
        throw new Error("This owner no longer supports review Auto-fix. Update that PwrAgent instance before starting this review.");
      }
      const navigation = await this.context.host().readBoundThreadConfiguration(params.binding);
      const settings = turnSettingsForBinding(params.binding, navigation);
      const reviewer = {
        backend: params.reviewBackend ?? params.binding.backend,
        ...(params.reviewerLabel ? { label: params.reviewerLabel } : {}),
        ...(params.reviewBackend
          ? {
              ...(params.model ? { model: params.model } : {}),
              ...(params.reasoningEffort
                ? { reasoningEffort: params.reasoningEffort }
                : {}),
              source: "override" as const,
            }
          : {
              ...(settings.model ? { model: settings.model } : {}),
              ...(settings.reasoningEffort
                ? { reasoningEffort: settings.reasoningEffort }
                : {}),
              source: "thread_default" as const,
            }),
      };
      const result = await submitReview({
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        target: params.target,
        delivery: "inline",
        ...(params.runMode ? { runMode: params.runMode } : {}),
        ...(afterReview ? { afterReview } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        // An explicit reviewer replaces the binding's inherited settings
        // wholesale — its model belongs to a different catalog.
        ...(params.reviewBackend
          ? {
              reviewBackend: params.reviewBackend,
              ...(params.model ? { model: params.model } : {}),
              ...(params.reasoningEffort
                ? { reasoningEffort: params.reasoningEffort }
                : {}),
            }
          : {
              ...(settings.model ? { model: settings.model } : {}),
              ...(settings.reasoningEffort
                ? { reasoningEffort: settings.reasoningEffort }
                : {}),
              ...(settings.serviceTier
                ? { serviceTier: settings.serviceTier }
                : {}),
              ...(settings.fastMode !== undefined
                ? { fastMode: settings.fastMode }
                : {}),
            }),
      });
      if (params.pendingIntentId) {
        await this.context.store.deletePendingIntent(params.pendingIntentId);
      }
      await this.context.host().deliver(
        buildReviewStartConfirmationIntent({
          id: this.context.host().newIntentId("review-submitted"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          notification: {
            status: result.status,
            target: messagingReviewStartTarget(params.target),
            reviewer,
          },
          ...(params.targetSurface
            ? {
                targetSurface: params.targetSurface,
                delivery: {
                  mode: "update" as const,
                  replaceMarkup: true,
                  fallback: "present_new" as const,
                },
              }
            : {}),
        }),
        params.binding,
        params.event,
      );
    } catch (error) {
      this.context.logger.warn?.("messaging review submission failed", {
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("review-submit-failed"),
          createdAt: this.context.now(),
          title: "Review could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
    }
  }

  async deliverReviewUnsupported(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("review-unsupported"),
        createdAt: this.context.now(),
        title: "Review unavailable",
        body: "This thread backend does not support code review.",
        recoverable: false,
      }),
      binding,
      event,
    );
  }

  /**
   * Providers on this instance that can run a review, with the models and
   * reasoning levels each offers. Drives the configurator's Provider / Model /
   * Effort buttons. Returns an empty list — which hides those buttons — when
   * nothing advertises `reviewRunner`, so an instance that predates reviewer
   * overrides never offers a choice it cannot honor.
   */
  async listReviewerBackends(): Promise<
    NonNullable<MessagingReviewIntent["review"]["reviewerBackends"]>
  > {
    try {
      const response = await this.context.backend.listBackends?.({
        includeUnavailable: false,
      });
      return (response?.backends ?? [])
        .filter((candidate) =>
          candidate.capabilities.reviewRunner === true
          || candidate.capabilities.reviewRunMode === true
          || candidate.capabilities.reviewAutoFix === true,
        )
        .map((candidate) => ({
          backend: candidate.kind,
          label: candidate.label,
          capabilities: candidate.capabilities,
          models: (candidate.launchpadOptions?.models ?? []).map((model) => ({
            id: model.id,
            label: model.label ?? model.id,
            other: model.other,
            providerId: model.providerId,
            providerLabel: model.providerLabel,
            reasoningEfforts:
              model.reasoningEfforts
              ?? candidate.launchpadOptions?.reasoningEfforts
              ?? [],
          })),
        }));
    } catch (error) {
      this.context.logger.debug?.("messaging reviewer backend lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async reviewSupportedForBinding(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    if (!this.context.backend.submitReview) {
      return false;
    }
    try {
      const summary = await this.context.host().getBackendSummary(binding.backend);
      return Boolean(summary?.available && summary.capabilities.startReview);
    } catch (error) {
      this.context.logger.debug?.("messaging review capability lookup failed", {
        backend: binding.backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

function turnSettingsForBinding(
  binding: MessagingBindingRecord,
  navigation?: MessagingNavigationContext,
): {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
} {
  const thread = findThreadForBinding(navigation, binding);
  return turnSettingsForThread(
    binding,
    thread,
    resolveExecutionModeForThread(binding, thread),
  );
}

function reviewWorkspaceMatches(
  directoryPath: string | undefined,
  cwd: string | undefined,
): boolean {
  if (!directoryPath || !cwd) {
    return false;
  }
  const normalize = (value: string) => value.replace(/\/+$/, "");
  return normalize(directoryPath) === normalize(cwd);
}

function reviewWorkspaceContains(
  workspacePath: string | undefined,
  cwd: string | undefined,
): boolean {
  if (!workspacePath || !cwd) {
    return false;
  }
  const relative = path.relative(
    path.resolve(workspacePath),
    path.resolve(cwd),
  );
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function reviewThreadForWorkspace(
  thread: NavigationThreadSummary | undefined,
  cwd: string | undefined,
): NavigationThreadSummary | undefined {
  if (!thread || thread.linkedDirectories.length <= 1) {
    return thread;
  }
  return reviewWorkspaceContains(cwd, thread.projectKey)
    ? thread
    : undefined;
}

function paginateReviewWorkspaces(params: {
  itemCount: number;
  maxActions: number | undefined;
  pageIndex: number | undefined;
}): {
  endIndex: number;
  pageIndex: number;
  startIndex: number;
  totalPages: number;
} {
  const maxActions =
    params.maxActions === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.trunc(params.maxActions));
  const singlePageSize = Math.max(1, maxActions - 2);
  const pageSize =
    params.itemCount > singlePageSize
      ? Math.max(1, maxActions - 4)
      : singlePageSize;
  const totalPages = Math.max(1, Math.ceil(params.itemCount / pageSize));
  const requestedPage = Math.max(0, Math.trunc(params.pageIndex ?? 0));
  const pageIndex = Math.min(requestedPage, totalPages - 1);
  const startIndex = pageIndex * pageSize;
  return {
    endIndex: Math.min(params.itemCount, startIndex + pageSize),
    pageIndex,
    startIndex,
    totalPages,
  };
}

function messagingReviewBranchOptions(params: {
  directory: Pick<NavigationDirectorySummary, "gitStatus"> | undefined;
  thread: NavigationThreadSummary | undefined;
}): string[] {
  const options = buildReviewBranchOptions(params);
  const primaryBranch = options[0]?.trim();
  const localBranchNames = new Set(
    [
      ...(params.directory?.gitStatus?.branches ?? []),
      params.directory?.gitStatus?.defaultBranch,
    ]
      .map((branch) => branch?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  const baseBranchNames = new Set(
    (params.directory?.gitStatus?.baseBranches ?? [])
      .map((branch) => branch.trim())
      .filter(Boolean),
  );
  const knownBranchNames = new Set(
    [...localBranchNames, ...baseBranchNames],
  );
  const conventionalBaseBranches = new Set([
    "main",
    "master",
    "develop",
    "trunk",
  ]);
  const conventionalName = (branch: string): string | undefined => {
    const value = branch.trim();
    if (conventionalBaseBranches.has(value)) {
      return value;
    }
    if (!baseBranchNames.has(value) || localBranchNames.has(value)) {
      return undefined;
    }
    const remoteSeparator = value.indexOf("/");
    const remoteBranch =
      remoteSeparator >= 0 ? value.slice(remoteSeparator + 1) : "";
    return conventionalBaseBranches.has(remoteBranch)
      ? remoteBranch
      : undefined;
  };
  const knownConventionalOptions = options.filter(
    (branch) =>
      knownBranchNames.has(branch.trim())
      && Boolean(conventionalName(branch)),
  );
  const keepPrimary =
    primaryBranch !== undefined
    && (
      knownBranchNames.has(primaryBranch)
      || primaryBranch !== "main"
      || knownConventionalOptions.length === 0
    );
  return [
    ...(keepPrimary && primaryBranch ? [primaryBranch] : []),
    ...knownConventionalOptions,
  ]
    .filter((branch, index, branches) => branches.indexOf(branch) === index)
    .slice(0, 8);
}

function formatMessagingReviewScope(target: AppServerReviewTarget): string {
  switch (target.type) {
    case "pullRequest":
      return "Attached Pull Request";
    case "pullRequests":
      return "Attached Pull Requests";
    case "branch":
      return "Branch";
    case "path":
      return "Path";
    case "uncommittedChanges":
      return "Current Changes";
    case "baseBranch":
      return "Base Branch";
    case "commit":
      return "Commit";
    case "custom":
      return "Custom";
  }
}
