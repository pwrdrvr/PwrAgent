export const APP_SERVER_LIST_THREADS_CHANNEL = "app-server:list-threads";
export const THREAD_SEARCH_CHANNEL = "thread-search:search";
export const APP_SERVER_READ_THREAD_CHANNEL = "app-server:read-thread";
export const APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL =
  "app-server:get-thread-file-diff";
export const APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL =
  "app-server:persist-thread-usage-activity";
export const APP_SERVER_LIST_SKILLS_CHANNEL = "app-server:list-skills";
export const APP_SERVER_ARCHIVE_THREAD_CHANNEL = "app-server:archive-thread";
export const APP_SERVER_RESTORE_THREAD_CHANNEL = "app-server:restore-thread";
export const APP_SERVER_ARCHIVE_WORKTREE_CHANNEL = "app-server:archive-worktree";
export const APP_SERVER_RESTORE_WORKTREE_CHANNEL = "app-server:restore-worktree";
export const APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL =
  "app-server:handoff-thread-workspace";
export const APP_SERVER_RENAME_THREAD_CHANNEL = "app-server:rename-thread";
export const THREAD_MIGRATION_LIST_SOURCES_CHANNEL =
  "thread-migration:list-sources";
export const THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL =
  "thread-migration:list-source-threads";
export const THREAD_MIGRATION_START_CHANNEL = "thread-migration:start";
export const THREAD_MIGRATION_RETRY_CHANNEL = "thread-migration:retry";
export const FOCUSED_DIFF_ANALYZE_CHANNEL = "focused-diff:analyze";
export const BACKEND_LIST_CHANNEL = "backend:list";
export const ACP_AGENTS_LIST_CHANNEL = "acp-agents:list";
export const AGENT_START_THREAD_CHANNEL = "agent:start-thread";
export const AGENT_FORK_THREAD_CHANNEL = "agent:fork-thread";
export const AGENT_START_TURN_CHANNEL = "agent:start-turn";
export const AGENT_START_REVIEW_CHANNEL = "agent:start-review";
export const AGENT_COMPACT_THREAD_CHANNEL = "agent:compact-thread";
export const AGENT_INTERRUPT_TURN_CHANNEL = "agent:interrupt-turn";
export const AGENT_STEER_TURN_CHANNEL = "agent:steer-turn";
export const AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL = "agent:set-thread-execution-mode";
export const AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL =
  "agent:queue-thread-execution-mode";
export const AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL =
  "agent:cancel-thread-execution-mode-queue";
export const AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL =
  "agent:set-acp-session-runtime-option";
export const AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL = "agent:set-thread-model-settings";
export const AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL = "agent:check-thread-branch-drift";
export const AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL =
  "agent:update-thread-expected-branch";
export const AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL =
  "agent:retain-thread-branch-drift";
export const AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL =
  "agent:materialize-directory-launchpad";
export const CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL =
  "codex-environment:setup-progress";
export const AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL =
  "agent:run-codex-environment-action";
export const AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL =
  "agent:stop-codex-environment-action";
export const AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL =
  "agent:set-codex-thread-environment";
export const AGENT_SUBMIT_SERVER_REQUEST_CHANNEL = "agent:submit-server-request";
export const AGENT_TRUST_CODEX_PROJECT_CHANNEL = "agent:trust-codex-project";
export const AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL =
  "agent:latest-codex-config-warning";
export const AGENT_EVENT_CHANNEL = "agent:event";
export const NAVIGATION_SNAPSHOT_CHANNEL = "navigation:get-snapshot";
export const NAVIGATION_SET_BROWSE_MODE_CHANNEL =
  "navigation:set-browse-mode";
export const NAVIGATION_MARK_THREAD_SEEN_CHANNEL = "navigation:mark-thread-seen";
export const NAVIGATION_SET_THREAD_REACTION_CHANNEL =
  "navigation:set-thread-reaction";
export const NAVIGATION_SET_THREAD_PIN_CHANNEL =
  "navigation:set-thread-pin";
export const NAVIGATION_SET_THREAD_AGENT_CHANNEL =
  "navigation:set-thread-agent";
export const NAVIGATION_REORDER_THREAD_PINS_CHANNEL =
  "navigation:reorder-thread-pins";
export const NAVIGATION_SET_THREAD_PARENT_CHANNEL =
  "navigation:set-thread-parent";
export const NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL =
  "navigation:update-subthread-order";
export const NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL =
  "navigation:set-subthreads-collapsed";
/**
 * Directory pin IPC (plan 2026-05-09-002, Unit G). Mirror of the
 * thread-pin channels with the per-backend dimension dropped —
 * directory keys are globally unique, so pin order is global. The
 * main-process handler validates that the directoryKey corresponds
 * to a `kind: "directory"` summary (workspace / unlinked pseudo-
 * directories are rejected) before writing to the overlay store.
 */
export const NAVIGATION_SET_DIRECTORY_PIN_CHANNEL =
  "navigation:set-directory-pin";
export const NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL =
  "navigation:reorder-directory-pins";
export const NAVIGATION_REFRESH_THREAD_PRS_CHANNEL =
  "navigation:refresh-thread-prs";
export const NAVIGATION_DETACH_THREAD_PR_CHANNEL =
  "navigation:detach-thread-pr";
export const NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL =
  "navigation:attach-directory-to-thread";
export const NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL =
  "navigation:detach-directory-from-thread";
export const NAVIGATION_GET_GH_STATUS_CHANNEL =
  "navigation:get-gh-status";
export const NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL =
  "navigation:refresh-directory-git-statuses";
export const NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL =
  "navigation:resolve-edit-commit-states";
export const NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL =
  "navigation:list-worktree-other-changes";
export const NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL =
  "navigation:get-worktree-other-change-diff";
export const MESSAGING_GET_PLATFORM_STATUSES_CHANNEL =
  "messaging:get-platform-statuses";
export const MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL =
  "messaging:platform-status-event";
export const MESSAGING_UNBIND_THREAD_CHANNEL = "messaging:unbind-thread";
export const MESSAGING_SET_ENABLED_CHANNEL = "messaging:set-enabled";
export const MESSAGING_LIST_ACTIVITY_CHANNEL = "messaging:list-activity";
export const MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL =
  "messaging:get-activity-summary";
export const MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL =
  "messaging:generate-pairing-token";
export const MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL =
  "messaging:list-pairing-requests";
export const MESSAGING_APPROVE_PAIRING_CHANNEL = "messaging:approve-pairing";
export const MESSAGING_REJECT_PAIRING_CHANNEL = "messaging:reject-pairing";
export const MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL =
  "messaging:pairing-changed";
export const AUTOMATIONS_LIST_CHANNEL = "automations:list";
export const AUTOMATIONS_CREATE_CHANNEL = "automations:create";
export const AUTOMATIONS_UPDATE_CHANNEL = "automations:update";
export const AUTOMATIONS_DELETE_CHANNEL = "automations:delete";
export const AUTOMATIONS_PAUSE_CHANNEL = "automations:pause";
export const AUTOMATIONS_RESUME_CHANNEL = "automations:resume";
export const AUTOMATIONS_RUN_NOW_CHANNEL = "automations:run-now";
export const AUTOMATIONS_LIST_RUNS_CHANNEL = "automations:list-runs";
export const AUTOMATIONS_LIST_CARDS_CHANNEL = "automations:list-cards";
export const AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL =
  "automations:get-run-artifact";
export const AUTOMATIONS_LOAD_ISSUES_CHANNEL = "automations:load-issues";
export const AUTOMATIONS_DRAFT_PROMPT_CHANNEL = "automations:draft-prompt";
/**
 * Fire-and-forget IPC: opens the dedicated Messaging Activity window
 * (or focuses it if already open). The activity surface is a separate
 * BrowserWindow with its own traffic lights and lifecycle, NOT a
 * settings section. See `showMessagingActivityWindow` in
 * `apps/desktop/src/main/messaging-activity-window.ts`.
 */
export const MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL =
  "messaging:open-activity-window";
/**
 * Stop the messaging runtime in *this* process. Used by the wizard's
 * graduation path: the bootstrap process is about to spawn a child
 * Electron pointed at the operator's chosen profile, and both
 * processes would otherwise compete for the same long-poll (Telegram
 * `getUpdates` returns 409 when two processes ask at once). Calling
 * this before the spawn lets the bootstrap release the polling slot
 * cleanly; the child then comes up without colliding.
 *
 * Idempotent — calling it when no runtime is running is a no-op.
 */
export const MESSAGING_SHUTDOWN_RUNTIME_CHANNEL =
  "messaging:shutdown-runtime";
/**
 * Drives the per-credential "Test" button on Settings → Messaging
 * and Settings → Models. Request payload: `{ kind: "telegram" |
 * "discord" | "grok" | "codex" }`. Response: `SettingsCredentialTestResult`.
 *
 * The probe runs entirely in the main process — secrets never leave
 * it. The result returned to the renderer contains only public
 * identity (bot username, model IDs, codex version), never the
 * token or API key.
 */
export const SETTINGS_TEST_CREDENTIALS_CHANNEL =
  "settings:test-credentials";
/**
 * Sibling channel for "what was the last result?" — driven on
 * settings-pane mount so the test block can render the previous
 * status without auto-firing a fresh probe.
 */
export const SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL =
  "settings:last-credential-test";
export const SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL =
  "settings:resolve-messaging-contact";
/**
 * Fired main → renderer whenever the messaging store has had bindings
 * created, revoked, or had their conversation metadata change. The
 * payload is intentionally minimal — receivers should refetch the
 * navigation snapshot rather than try to apply per-binding diffs from
 * the event itself. See `useThreadNavigation` for the renderer-side
 * subscription, and `MessagingController.bindChannelToThread` /
 * `syncConversationName` / `refreshBindingFromInbound` /
 * `detachBinding` plus the `messaging:unbind-thread` IPC handler for
 * the emit sites.
 */
export const MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL =
  "messaging:bindings-changed";
export const MESSAGING_START_INBOUND_PREVIEW_CHANNEL =
  "messaging:start-inbound-preview";
export const MESSAGING_STOP_INBOUND_PREVIEW_CHANNEL =
  "messaging:stop-inbound-preview";
export const MESSAGING_INBOUND_PREVIEW_EVENT_CHANNEL =
  "messaging:inbound-preview-event";
export const MESSAGING_LIST_INBOUND_TOPICS_CHANNEL =
  "messaging:list-inbound-topics";
export const NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL =
  "navigation:ensure-directory-launchpad";
export const NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL =
  "navigation:update-directory-launchpad";
export const NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL =
  "navigation:reset-directory-launchpad";
/**
 * IPC channels backing the project-directory picker (issue #223). The
 * renderer first asks the main process to open the OS dialog (`pick`)
 * and, on a confirmed pick, follows up with `register` so the main
 * process can validate the path and seed a launchpad in one round-trip.
 * Splitting them keeps the dialog itself uncancelable from the renderer
 * while letting the picker surface validation errors inline.
 */
export const NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL =
  "navigation:pick-directory-from-disk";
export const NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL =
  "navigation:register-directory-from-disk";
export const COMPOSER_DRAFT_SAVE_CHANNEL = "composer-draft:save";
export const COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL =
  "composer-draft:record-history";
export const COMPOSER_DRAFT_CLEAR_CHANNEL = "composer-draft:clear";
export const COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL =
  "composer-draft:list-candidates";
export const COMPOSER_DRAFT_LIST_LATEST_CHANNEL = "composer-draft:list-latest";
export const RENDERER_ERROR_REPORT_CHANNEL = "renderer:error-report";
export const IMAGE_UPLOAD_FALLBACK_CHANNEL = "image-upload:fallback";
export const IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL =
  "image-upload:normalization-log";
export const PRELOAD_LOG_CHANNEL = "preload:log";
export const STARTUP_PROFILE_EVENT_CHANNEL = "startup-profile:event";
export const WINDOW_FOCUS_SYNC_CHANNEL = "window:focus-sync";
/**
 * Main → renderer push: fired on `enter-full-screen` / `leave-full-screen`
 * for the main window. macOS hides the traffic-light stoplights in native
 * fullscreen, so the renderer toggles `<html data-fullscreen>` to drop the
 * reserved stoplight inset (the dead gap that would otherwise remain where
 * the lights used to be).
 */
export const WINDOW_FULLSCREEN_SYNC_CHANNEL = "window:fullscreen-sync";
export const WINDOW_POINTER_SNAPSHOT_CHANNEL = "window:pointer-snapshot";
/**
 * Main → renderer push: fired when the user invokes File → New Thread
 * or presses the native `CmdOrCtrl+N` accelerator. The renderer's
 * `App` shell listens on this channel and routes into the existing
 * `navigation.createThread()` launchpad flow.
 */
export const WINDOW_OPEN_NEW_THREAD_CHANNEL = "window:open-new-thread";
/**
 * Main -> renderer push: fired when an out-of-app surface, such as a
 * native approval notification, asks the main window to focus a known thread.
 */
export const WINDOW_SHOW_THREAD_CHANNEL = "window:show-thread";
/**
 * Main → renderer push: fired when the user invokes the app's
 * "Settings…" menu item (PwrAgent → Settings… on macOS, Help → ...
 * on Linux/Windows). The renderer's `App` shell listens on this
 * channel and switches `mainView` to the Settings overlay, mirroring
 * what the sidebar gear-icon button does. Settings is an in-renderer
 * overlay (not a separate BrowserWindow) so the menu can't open it
 * directly from the main process.
 */
export const WINDOW_OPEN_SETTINGS_CHANNEL = "window:open-settings";
/**
 * Main → renderer push: re-open the first-run onboarding wizard from
 * the Help menu. Does NOT touch the per-profile `onboarding.completed`
 * flag — re-entry is transient.
 */
export const WINDOW_REPLAY_ONBOARDING_CHANNEL = "window:replay-onboarding";
export const RUNTIME_IDENTITY_CHANNEL = "runtime:get-identity";
export const SETTINGS_READ_CHANNEL = "settings:read";
export const SETTINGS_WRITE_CONFIG_CHANNEL = "settings:write-config";
export const SETTINGS_REPLACE_SECRET_CHANNEL = "settings:replace-secret";
export const SETTINGS_CLEAR_SECRET_CHANNEL = "settings:clear-secret";
export const SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL =
  "settings:refresh-codex-discovery";
export const SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL =
  "settings:create-codex-auth-profile";
export const SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL =
  "settings:start-codex-auth-profile-login";
export const SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL =
  "settings:check-codex-auth-profile-status";
export const SETTINGS_PICK_GH_COMMAND_CHANNEL =
  "settings:pick-gh-command";
export const ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL =
  "onboarding:complete-codex-bootstrap";
export const APPLICATION_OPEN_CHANNEL = "application:open";
export const PATH_OPEN_CHANNEL = "path:open";
export const PATH_REVEAL_CHANNEL = "path:reveal";
export const MARKDOWN_FILE_READ_CHANNEL = "markdown-file:read";
export const MARKDOWN_FILE_VIEWER_OPEN_CHANNEL = "markdown-file-viewer:open";
export const MARKDOWN_FILE_VIEWER_SNAPSHOT_READ_CHANNEL =
  "markdown-file-viewer:read-snapshot";
export const MARKDOWN_FILE_VIEWER_SNAPSHOT_CHANGED_CHANNEL =
  "markdown-file-viewer:snapshot-changed";
export const INTEGRATED_TERMINAL_CREATE_CHANNEL =
  "integrated-terminal:create";
export const INTEGRATED_TERMINAL_WRITE_CHANNEL = "integrated-terminal:write";
export const INTEGRATED_TERMINAL_RESIZE_CHANNEL =
  "integrated-terminal:resize";
export const INTEGRATED_TERMINAL_CLOSE_CHANNEL = "integrated-terminal:close";
export const INTEGRATED_TERMINAL_OUTPUT_CHANNEL = "integrated-terminal:output";
export const INTEGRATED_TERMINAL_EXIT_CHANNEL = "integrated-terminal:exit";
export const INTEGRATED_TERMINAL_ERROR_CHANNEL = "integrated-terminal:error";
export const APP_METADATA_READ_CHANNEL = "app:read-metadata";
export const APP_LICENSE_DOCUMENT_READ_CHANNEL = "app:read-license-document";
export const APP_CHANGELOG_DOCUMENT_READ_CHANNEL = "app:read-changelog-document";
export const APP_CHANGELOG_WINDOW_OPEN_CHANNEL = "app:open-changelog-window";
export const APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL =
  "app:open-third-party-notices-window";
export const APP_LOG_SNAPSHOT_READ_CHANNEL = "app:read-log-snapshot";
export const APP_LOG_ENTRY_EVENT_CHANNEL = "app:log-entry-event";
export const APP_LOG_DEBUG_COLLECTION_SET_CHANNEL =
  "app:set-log-debug-collection";
export const APP_LOG_WINDOW_OPEN_CHANNEL = "app:open-log-window";
export const APP_UPDATE_CHECK_CHANNEL = "app:check-for-updates";
export const APP_UPDATE_STATUS_READ_CHANNEL = "app:read-update-status";
export const APP_UPDATE_STATUS_EVENT_CHANNEL = "app:update-status-event";
export const HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL =
  "hot-cpu-profile:captured";
/** Main → renderer push: appearance (theme + density) was written to
 *  the per-profile config.toml by a settings update. Every BrowserWindow
 *  subscribes so secondary windows (changelog, app-log, license,
 *  messaging activity) can re-apply `<html data-theme/data-density>`
 *  live. Payload is `{ theme: DesktopAppearanceTheme; density:
 *  DesktopAppearanceDensity }`. */
export const APPEARANCE_CHANGED_EVENT_CHANNEL = "appearance:changed";
export const APP_UPDATE_INSTALL_CHANNEL = "app:install-update";
export const APP_UPDATE_RELEASES_READ_CHANNEL = "app:read-update-releases";
export const PROFILES_LIST_CHANNEL = "profiles:list";
export const PROFILES_OPEN_CHANNEL = "profiles:open";
export const PROFILES_CREATE_CHANNEL = "profiles:create";
export const PROFILES_SET_DEFAULT_CHANNEL = "profiles:set-default";
export const PROFILES_DELETE_CHANNEL = "profiles:delete";
export const PROFILES_SET_CODEX_PROFILE_CHANNEL = "profiles:set-codex-profile";
export const PROFILES_GRADUATE_BOOTSTRAP_CONFIG_CHANNEL =
  "profiles:graduate-bootstrap-config";
export const APP_GET_BOOT_INFO_CHANNEL = "app:get-boot-info";
export const APP_QUIT_CHANNEL = "app:quit";
export const APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL = "app:wait-for-profile-alive";
export const PROFILES_WRITE_SECRETS_CHANNEL = "profiles:write-secrets";
// Windows custom title-bar menu bar (see shared/app-menu.ts). `model` returns
// the top-level entries for the renderer's painted bar; `popup` pops the real
// native submenu at a button. Unused on macOS/Linux.
export const APP_MENU_MODEL_CHANNEL = "app-menu:model";
export const APP_MENU_POPUP_CHANNEL = "app-menu:popup";
