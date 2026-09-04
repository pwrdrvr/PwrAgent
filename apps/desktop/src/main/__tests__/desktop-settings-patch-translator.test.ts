import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits } from "../settings/desktop-config";
import { parseTomlTables } from "../settings/toml-editor";

describe("desktopSettingsPatchToEdits — general", () => {
  it("writes developer mode", () => {
    const edits = desktopSettingsPatchToEdits({
      general: {
        developerMode: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["general", "developer_mode"],
        value: true,
      },
    ]);
  });

  it("writes hot CPU profiling", () => {
    const edits = desktopSettingsPatchToEdits({
      general: {
        hotCpuProfilingEnabled: true,
        hotCpuProfilingStartDelayMs: 5000,
        hotCpuProfilingTriggerMode: "slowburn",
        hotCpuProfilingSlowburnThresholdPercent: 15,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["general", "hot_cpu_profiling_enabled"],
        value: true,
      },
      {
        op: "set",
        path: ["general", "hot_cpu_profiling_start_delay_ms"],
        value: 5000,
      },
      {
        op: "set",
        path: ["general", "hot_cpu_profiling_trigger_mode"],
        value: "slowburn",
      },
      {
        op: "set",
        path: ["general", "hot_cpu_profiling_slowburn_threshold_percent"],
        value: 15,
      },
    ]);
  });

  it("writes hot CPU heap snapshot settings", () => {
    const edits = desktopSettingsPatchToEdits({
      general: {
        hotCpuProfilingCaptureHeapSnapshot: true,
        hotCpuProfilingHeapSnapshotLimit: 3,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["general", "hot_cpu_profiling_capture_heap_snapshot"],
        value: true,
      },
      {
        op: "set",
        path: ["general", "hot_cpu_profiling_heap_snapshot_limit"],
        value: 3,
      },
    ]);
  });

  it("writes quit confirmation preference", () => {
    const edits = desktopSettingsPatchToEdits({
      general: {
        confirmQuitWithInProgressThreads: false,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["general", "confirm_quit_with_in_progress_threads"],
        value: false,
      },
    ]);
  });

  it("persists only the PDF analysis opt-out", () => {
    expect(
      desktopSettingsPatchToEdits({
        general: { pdfAnalysisEnabled: false },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["general", "pdf_analysis_enabled"],
        value: false,
      },
    ]);

    expect(
      desktopSettingsPatchToEdits({
        general: { pdfAnalysisEnabled: true },
      }),
    ).toEqual([
      {
        op: "delete",
        path: ["general", "pdf_analysis_enabled"],
      },
    ]);
  });

  it("writes tool-output alert trigger preferences", () => {
    const edits = desktopSettingsPatchToEdits({
      general: {
        toolOutputAlerts: {
          outputCapHitsEnabled: false,
          repeatedLargeOutputsEnabled: true,
          repeatedLargeOutputMinimumCalls: 7,
          repeatedLargeOutputMinimumPercent: 65,
          repeatedQueuedChecksEnabled: false,
        },
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["general", "tool_output_alerts", "output_cap_hits_enabled"],
        value: false,
      },
      {
        op: "set",
        path: [
          "general",
          "tool_output_alerts",
          "repeated_large_outputs_enabled",
        ],
        value: true,
      },
      {
        op: "set",
        path: [
          "general",
          "tool_output_alerts",
          "repeated_large_output_minimum_calls",
        ],
        value: 7,
      },
      {
        op: "set",
        path: [
          "general",
          "tool_output_alerts",
          "repeated_large_output_minimum_percent",
        ],
        value: 65,
      },
      {
        op: "set",
        path: [
          "general",
          "tool_output_alerts",
          "repeated_queued_checks_enabled",
        ],
        value: false,
      },
    ]);
  });

  it("writes the Token Miser opt-in", () => {
    expect(
      desktopSettingsPatchToEdits({
        experimental: { tokenMiserEnabled: true },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["experimental", "token_miser_enabled"],
        value: true,
      },
    ]);
  });

  it("writes the inherited Token Miser thread default", () => {
    expect(
      desktopSettingsPatchToEdits({
        experimental: { tokenMiserDefaultEnabled: false },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["experimental", "token_miser_default_enabled"],
        value: false,
      },
    ]);
  });

  it("preserves and mirrors the legacy general Token Miser key", () => {
    const edits = desktopSettingsPatchToEdits(
      {
        experimental: { tokenMiserEnabled: false },
      },
      parseTomlTables(
        [
          "[general]",
          "token_miser_enabled = true",
        ].join("\n"),
        "config.toml",
      ),
    );

    expect(edits).toEqual([
      {
        op: "ensureCommentBefore",
        path: ["general", "token_miser_enabled"],
        marker: "pwragent-legacy-settings",
        comment:
          "# pwragent-legacy-settings key=token_miser_enabled shape=boolean used_through=1.1.0-alpha.1 kept_for_older_clients",
      },
      {
        op: "set",
        path: ["general", "token_miser_enabled"],
        value: false,
      },
      {
        op: "set",
        path: ["experimental", "token_miser_enabled"],
        value: false,
      },
    ]);
  });

  it("writes spend alert preferences", () => {
    const edits = desktopSettingsPatchToEdits({
      general: {
        spendAlerts: {
          activeTurnSpendEnabled: false,
          activeTurnSpendThresholdUsd: 7.5,
          threadSpendEnabled: true,
          threadSpendThresholdUsd: 40,
        },
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["general", "spend_alerts", "active_turn_spend_enabled"],
        value: false,
      },
      {
        op: "set",
        path: [
          "general",
          "spend_alerts",
          "active_turn_spend_threshold_usd",
        ],
        value: 7.5,
      },
      {
        op: "set",
        path: ["general", "spend_alerts", "thread_spend_enabled"],
        value: true,
      },
      {
        op: "set",
        path: ["general", "spend_alerts", "thread_spend_threshold_usd"],
        value: 40,
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — experimental", () => {
  it("writes the Full Access risk warning dismissal flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        fullAccessRiskWarningDismissed: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "full_access_risk_warning_dismissed"],
        value: true,
      },
    ]);
  });

  it("writes the live transcript event filtering flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        liveTranscriptEventFiltering: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "live_transcript_event_filtering"],
        value: true,
      },
    ]);
  });

  it("writes the lightweight navigation refresh flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        lightweightNavigationRefresh: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "lightweight_navigation_refresh"],
        value: true,
      },
    ]);
  });

  it("writes the Markdown math rendering flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        markdownMathRendering: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "markdown_math_rendering"],
        value: true,
      },
    ]);
  });

  it("writes the thread pricing summary flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        threadPricingSummary: true,
        threadPricingDisplayUsd: false,
        threadPricingDisplayCodexCredits: true,
        threadToolAccounting: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "thread_pricing_summary"],
        value: true,
      },
      {
        op: "set",
        path: ["experimental", "thread_pricing_display_usd"],
        value: false,
      },
      {
        op: "set",
        path: ["experimental", "thread_pricing_display_codex_credits"],
        value: true,
      },
      {
        op: "set",
        path: ["experimental", "thread_tool_accounting"],
        value: true,
      },
    ]);
  });

  it("writes the Codex default-mode request_user_input flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        codexDefaultModeRequestUserInput: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "codex_default_mode_request_user_input"],
        value: true,
      },
    ]);
  });

  it("writes the managed review experiment flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: { managedReview: true },
    });

    expect(edits).toEqual([{
      op: "set",
      path: ["experimental", "managed_review"],
      value: true,
    }]);
  });
});

describe("desktopSettingsPatchToEdits — Git", () => {
  it("writes the canonical background PR polling key for a new config", () => {
    expect(
      desktopSettingsPatchToEdits({
        git: { backgroundPrPolling: false },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["git", "background_pr_polling"],
        value: false,
      },
    ]);
  });

  it("writes the GitHub PR automation controls", () => {
    expect(
      desktopSettingsPatchToEdits({
        git: {
          prAutoDispatchAllowed: false,
          defaultPrAutoDispatchEnabled: false,
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["git", "pr_auto_dispatch_allowed"],
        value: false,
      },
      {
        op: "set",
        path: ["git", "default_pr_auto_dispatch_enabled"],
        value: false,
      },
    ]);
  });

  it("writes the automatic repair budget controls", () => {
    expect(
      desktopSettingsPatchToEdits({
        git: {
          prAutoDispatchBudgetCapacity: 42,
          prAutoDispatchBudgetRefillPerMinute: 3,
          pausePrAutoDispatchWhenBudgetEmpty: false,
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["git", "pr_auto_dispatch_budget_capacity"],
        value: 42,
      },
      {
        op: "set",
        path: ["git", "pr_auto_dispatch_budget_refill_per_minute"],
        value: 3,
      },
      {
        op: "set",
        path: ["git", "pause_pr_auto_dispatch_when_budget_empty"],
        value: false,
      },
    ]);
  });

  it("preserves and mirrors a recognized experimental polling key", () => {
    const edits = desktopSettingsPatchToEdits(
      {
        git: { backgroundPrPolling: true },
      },
      parseTomlTables(
        [
          "[experimental]",
          "background_pr_polling = false",
        ].join("\n"),
        "config.toml",
      ),
    );

    expect(edits).toEqual([
      {
        op: "ensureCommentBefore",
        path: ["experimental", "background_pr_polling"],
        marker: "pwragent-legacy-settings",
        comment:
          "# pwragent-legacy-settings key=background_pr_polling shape=boolean used_through=1.0.0-beta.50 kept_for_older_clients",
      },
      {
        op: "set",
        path: ["experimental", "background_pr_polling"],
        value: true,
      },
      {
        op: "set",
        path: ["git", "background_pr_polling"],
        value: true,
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — image uploads", () => {
  it("writes non-default pasted image patch budgets", () => {
    expect(
      desktopSettingsPatchToEdits({
        imageUploads: {
          pastedImageMaxPatches: 4096,
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["image_uploads", "pasted_image_max_patches"],
        value: 4096,
      },
    ]);
  });

  it("removes the pasted image patch budget when saving the default", () => {
    expect(
      desktopSettingsPatchToEdits({
        imageUploads: {
          pastedImageMaxPatches: 1536,
        },
      }),
    ).toEqual([
      {
        op: "delete",
        path: ["image_uploads", "pasted_image_max_patches"],
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — updates", () => {
  it("writes the prerelease update channel", () => {
    expect(
      desktopSettingsPatchToEdits({
        updates: {
          channel: "prerelease",
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["updates", "channel"],
        value: "prerelease",
      },
      {
        op: "set",
        path: ["updates", "selection_source"],
        value: "user",
      },
    ]);
  });

  it("persists the latest update channel so a Beta binary does not re-infer", () => {
    expect(
      desktopSettingsPatchToEdits({
        updates: {
          channel: "latest",
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["updates", "channel"],
        value: "latest",
      },
      {
        op: "set",
        path: ["updates", "selection_source"],
        value: "user",
      },
    ]);
  });

  it("writes the beta update train", () => {
    expect(
      desktopSettingsPatchToEdits({
        updates: {
          train: "beta",
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["updates", "train"],
        value: "beta",
      },
      {
        op: "set",
        path: ["updates", "selection_source"],
        value: "user",
      },
    ]);
  });

  it("persists the stable update train so a Beta binary does not re-infer", () => {
    expect(
      desktopSettingsPatchToEdits({
        updates: {
          train: "stable",
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["updates", "train"],
        value: "stable",
      },
      {
        op: "set",
        path: ["updates", "selection_source"],
        value: "user",
      },
    ]);
  });

  it("derives the pin marker once for a patch naming both axes", () => {
    // `selection_source` is main-owned: it is absent from the patch type and
    // derived here, so no renderer can pin — or un-pin — a selection nobody
    // picked, and no call site can persist a slot the next read would
    // silently re-infer away.
    expect(
      desktopSettingsPatchToEdits({
        updates: { channel: "prerelease", train: "beta" },
      }),
    ).toEqual([
      { op: "set", path: ["updates", "channel"], value: "prerelease" },
      { op: "set", path: ["updates", "train"], value: "beta" },
      { op: "set", path: ["updates", "selection_source"], value: "user" },
    ]);
  });

  it("writes no pin marker for a patch that names neither axis", () => {
    expect(desktopSettingsPatchToEdits({ updates: {} })).toEqual([]);
  });
});

describe("desktopSettingsPatchToEdits — messaging attachments", () => {
  it("writes non-default image upload profiles", () => {
    expect(
      desktopSettingsPatchToEdits({
        messaging: {
          attachments: { imageProfile: "high" },
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["messaging", "attachments", "image_profile"],
        value: "high",
      },
    ]);
  });

  it("removes the image upload profile when saving the default", () => {
    expect(
      desktopSettingsPatchToEdits({
        messaging: {
          attachments: { imageProfile: "medium" },
        },
      }),
    ).toEqual([
      {
        op: "delete",
        path: ["messaging", "attachments", "image_profile"],
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — Mattermost", () => {
  it("emits one set op per defined Mattermost field with the correct snake_case key", () => {
    const edits = desktopSettingsPatchToEdits({
      messaging: {
        mattermost: {
          enabled: true,
          streamingResponses: false,
          serverUrl: "https://chat.example.com",
          callbackBaseUrl: "https://callbacks.example.com",
          slashCommandPrefix: "pwragent_",
          registerSlashCommands: true,
          authorizedUserIds: [
            { id: "abc", displayName: "Alice" },
            { id: "def", displayName: "Dev Team" },
          ],
          authorizedTeams: [
            { id: "teamabcdefghijklmnopqrstu1", displayName: "Dev Team" },
          ],
          authorizedConversations: [
            { id: "channelabcdefghijklmn12345", displayName: "Town Square" },
          ],
        },
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["messaging", "mattermost", "enabled"],
        value: true,
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "streaming_responses"],
        value: false,
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "server_url"],
        value: "https://chat.example.com",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "callback_base_url"],
        value: "https://callbacks.example.com",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "slash_command_prefix"],
        value: "pwragent_",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "register_slash_commands"],
        value: true,
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_user_ids"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
        value: [
          { id: "abc", display_name: "Alice" },
          { id: "def", display_name: "Dev Team" },
        ],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_team_ids"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_team_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_teams_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_teams_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_team_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_team_ids_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_teams"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_teams"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_teams"],
        value: [
          { id: "teamabcdefghijklmnopqrstu1", display_name: "Dev Team" },
        ],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversation_ids"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversation_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversations_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversations_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversation_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversation_ids_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversations"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversations"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_conversations"],
        value: [
          { id: "channelabcdefghijklmn12345", display_name: "Town Square" },
        ],
      },
    ]);
  });

  it("keeps a legacy scalar mirror when the current config already has one", () => {
    const tables = parseTomlTables(
      "[messaging.mattermost]\nauthorized_user_ids = [\"old\"]\n",
      "/tmp/config.toml",
    );

    const edits = desktopSettingsPatchToEdits(
      {
        messaging: {
          mattermost: {
            authorizedUserIds: [{ id: "abc", displayName: "Alice" }],
          },
        },
      },
      tables,
    );

    expect(edits).toEqual([
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "ensureCommentBefore",
        path: ["messaging", "mattermost", "authorized_user_ids"],
        marker: "pwragent-legacy-settings",
        comment:
          "# pwragent-legacy-settings key=authorized_user_ids shape=string-array used_through=1.0.0-alpha.9 kept_for_older_clients",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "authorized_user_ids"],
        value: ["abc"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
        value: [{ id: "abc", display_name: "Alice" }],
      },
    ]);
  });

  it("emits no ops when the Mattermost patch is empty", () => {
    expect(
      desktopSettingsPatchToEdits({ messaging: { mattermost: {} } }),
    ).toEqual([]);
  });

  it("emits ops only for the fields that are defined", () => {
    const edits = desktopSettingsPatchToEdits({
      messaging: {
        mattermost: {
          serverUrl: "https://chat.example.com",
        },
      },
    });
    expect(edits).toEqual([
      {
        op: "set",
        path: ["messaging", "mattermost", "server_url"],
        value: "https://chat.example.com",
      },
    ]);
  });
});
