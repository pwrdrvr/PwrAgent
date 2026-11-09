module.exports = {
  forbidden: [
    {
      name: "desktop-ui-has-no-native-git-access",
      severity: "error",
      comment: "UI Git reads must use IPC and the main-process stores; no native process or Git implementation access.",
      from: { path: "^apps/desktop/src/renderer/" },
      to: { reachable: true, path: "^(apps/desktop/src/main/|(?:node:)?child_process(?:/|$)|(dugite|simple-git|isomorphic-git)(/|$)|node_modules/.*/(dugite|simple-git|isomorphic-git)/|node_modules/(dugite|simple-git|isomorphic-git)/)" },
    },
    {
      name: "desktop-git-probes-are-store-private",
      severity: "error",
      comment: "Only the Git info stores may reach raw directory probes. Consumers request facts; stores decide when to perform I/O.",
      from: { path: "^apps/desktop/src/", pathNot: "^apps/desktop/src/main/git-info/" },
      to: { path: "^apps/desktop/src/main/git-info/private/" },
    },
    {
      name: "desktop-git-cache-policy-has-no-io",
      severity: "error",
      comment: "Cache admission must stay free of filesystem and subprocess probes.",
      from: { path: "^apps/desktop/src/main/git-info/read-cache\\.ts$" },
      to: { path: "^(apps/desktop/src/main/git-info/private/|(?:node:)?(?:child_process|fs)(?:/|$))" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment:
        "All dependencies in the repository must remain acyclic.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "shared-is-a-leaf",
      severity: "error",
      comment:
        "packages/shared must not import any internal workspace package.",
      from: {
        path: "^packages/shared/",
      },
      to: {
        path: "^(@pwragent/|apps/|packages/(?!shared/))",
      },
    },
    {
      name: "workspace-packages-do-not-import-apps",
      severity: "error",
      comment:
        "Workspace libraries and the Outpost must remain independent of host applications.",
      from: { path: "^packages/" },
      to: { path: "^(@pwragent/desktop(?:/|$)|apps/)" },
    },
    {
      name: "federation-only-imports-shared",
      severity: "error",
      comment:
        "Federation is a reusable transport layer; shared is its only internal dependency.",
      from: { path: "^packages/federation/" },
      to: {
        path: "^(@pwragent/(?!federation(?:/|$)|shared(?:/|$))|pwragent(?:/|$)|packages/(?!federation/|shared/))",
      },
    },
    {
      name: "agent-tools-only-imports-shared",
      severity: "error",
      comment:
        "Agent tool contracts and routing depend on shared, not on transports or owner implementations.",
      from: { path: "^packages/agent-tools/" },
      to: {
        path: "^(@pwragent/(?!agent-tools(?:/|$)|shared(?:/|$))|pwragent(?:/|$)|packages/(?!agent-tools/|shared/))",
      },
    },
    {
      name: "messaging-interface-only-imports-shared",
      severity: "error",
      comment:
        "The messaging interface is independent of the other reusable libraries and owner implementations.",
      from: { path: "^packages/messaging/interface/" },
      to: {
        path: "^(@pwragent/(?!messaging-interface(?:/|$)|shared(?:/|$))|pwragent(?:/|$)|packages/(?!messaging/interface/|shared/))",
      },
    },
    {
      name: "messaging-providers-only-import-interface",
      severity: "error",
      comment:
        "Messaging adapters depend only on their generic interface, never transport or owner libraries.",
      from: { path: "^packages/messaging/providers/([^/]+)/" },
      to: {
        path: "^(@pwragent/(?!messaging-interface(?:/|$))|pwragent(?:/|$)|packages/(?!messaging/interface/|messaging/providers/$1/))",
      },
    },
    {
      name: "owner-core-only-imports-shared",
      severity: "error",
      comment:
        "Owner policy depends only on shared, never transports, tool routing, providers or hosts.",
      from: { path: "^packages/owner-core/" },
      to: {
        path: "^(@pwragent/(?!owner-core(?:/|$)|shared(?:/|$))|pwragent(?:/|$)|packages/(?!owner-core/|shared/))",
      },
    },
    {
      name: "sqlite-storage-only-imports-storage-contracts",
      severity: "error",
      comment:
        "Profile SQLite schema, migrations and stores depend only on shared contracts and storage-agnostic owner ports, never hosts or transports.",
      from: { path: "^packages/sqlite-storage/" },
      to: {
        path: "^(@pwragent/(?!sqlite-storage(?:/|$)|shared(?:/|$)|owner-core(?:/|$))|pwragent(?:/|$)|packages/(?!sqlite-storage/|shared/|owner-core/))",
      },
    },
    {
      name: "owner-core-has-no-storage-format-dependencies",
      severity: "error",
      comment: "Owner storage ports cannot reach host stores, SQLite or file-format modules.",
      from: { path: "^packages/owner-core/" },
      to: {
        path: "^(?:apps/desktop/src/main/state/|packages/sqlite-storage/|@pwragent/sqlite-storage(?:/|$))|(?:^|/)(?:better-sqlite3|sqlite3|sql\\.js|yaml|js-yaml|toml|smol-toml|json5|jsonfile|write-file-atomic)(?:/|$)|\\.(?:json|jsonl|yaml|yml|toml)$",
      },
    },
    {
      name: "outpost-only-imports-reusable-libraries",
      severity: "error",
      comment:
        "The Outpost can bundle reusable owner libraries, but cannot depend on messaging provider adapters.",
      from: { path: "^packages/pwragent/" },
      to: {
        path: "^(@pwragent/(?!shared(?:/|$)|federation(?:/|$)|agent-tools(?:/|$)|messaging-interface(?:/|$)|owner-core(?:/|$)|sqlite-storage(?:/|$))|packages/(?!pwragent/|shared/|federation/|agent-tools/|messaging/interface/|owner-core/|sqlite-storage/))",
      },
    },
    {
      name: "outpost-application-storage-is-private",
      severity: "error",
      comment: "Only the bundle's host binding opens profile storage; Outpost application modules receive handle-free services.",
      from: { path: "^packages/pwragent/src/(?!federation-core\\.ts$)" },
      to: { path: "^(?:packages/sqlite-storage/|@pwragent/sqlite-storage(?:/|$))|(?:^|/)better-sqlite3(?:/|$)" },
    },
    {
      name: "outpost-workspace-imports-use-bundle-entry",
      severity: "error",
      comment:
        "Only src/federation-core.ts may import workspace libraries; the published JavaScript consumes its bundle.",
      from: {
        path: "^packages/pwragent/",
        pathNot: "^packages/pwragent/src/federation-core\\.ts$",
      },
      to: { path: "^(@pwragent/|packages/(?!pwragent/))" },
    },
    {
      name: "desktop-renderer-only-imports-shared",
      severity: "error",
      comment:
        "The renderer process may only import @pwragent/shared. All other package access goes through IPC.",
      from: {
        path: "^apps/desktop/src/renderer/",
      },
      to: {
        path: "^(@pwragent/(?!shared)|@pwrdrvr/codex-app-server-protocol|packages/(?!shared/))",
      },
    },
    {
      name: "messaging-interface-has-no-provider-dependencies",
      severity: "error",
      comment:
        "The generic messaging interface must stay independent of provider implementations and host apps.",
      from: {
        path: "^packages/messaging/interface/",
      },
      to: {
        path: "^(@pwragent/(messaging-provider|desktop)|@pwrdrvr/codex-app-server-protocol|apps/|packages/messaging/providers/)",
      },
    },
    {
      name: "messaging-providers-do-not-import-hosts",
      severity: "error",
      comment:
        "Messaging providers must be isolated packages; they cannot import desktop internals.",
      from: {
        path: "^packages/messaging/providers/",
      },
      to: {
        path: "^(@pwragent/desktop|@pwrdrvr/codex-app-server-protocol|apps/)",
      },
    },
    {
      name: "messaging-providers-use-interface-not-shared",
      severity: "error",
      comment:
        "Provider packages should depend on @pwragent/messaging-interface, not shared app contracts directly.",
      from: {
        path: "^packages/messaging/providers/",
      },
      to: {
        path: "^(@pwragent/shared|packages/shared/)",
      },
    },
    {
      name: "messaging-providers-do-not-import-sibling-providers",
      severity: "error",
      comment:
        "Each provider package should be isolated from every other provider package.",
      from: {
        path: "^packages/messaging/providers/([^/]+)/",
      },
      to: {
        path: "^(@pwragent/messaging-provider-|packages/messaging/providers/)",
        pathNot: "^packages/messaging/providers/$1/",
      },
    },
    {
      name: "desktop-messaging-core-does-not-import-providers",
      severity: "error",
      comment:
        "Workflow logic in desktop messaging/core must speak only the generic messaging contract.",
      from: {
        path: "^apps/desktop/src/main/messaging/core/",
      },
      to: {
        path: "^(@pwragent/messaging-provider-|packages/messaging/providers/)",
      },
    },
    {
      name: "desktop-messaging-core-does-not-import-provider-sdks",
      severity: "error",
      comment:
        "Provider SDKs belong in provider packages, not desktop messaging workflow logic.",
      from: {
        path: "^apps/desktop/src/main/messaging/core/",
      },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer"],
        path: "^(grammy|discord\\.js|telegraf)$",
      },
    },
    {
      name: "desktop-ipc-state-is-service-private",
      severity: "error",
      comment:
        "Desktop application modules reach persistent state through owner and application services. State internals and storage adapters own SQLite access.",
      from: {
        path: "^apps/desktop/src/main/(?!__tests__/|state/|storage/)",
      },
      to: {
        path: "^(?:apps/desktop/src/main/(?:state/|storage/(?:state-db|app-runtime-instance-store|thread-todo-store|thread-review-storage-sqlite|model-settings-recents-store|overlay-store-sqlite|thread-search-store|provider-thread-snapshot-store|automation-store|scheduled-thread-action-store|scheduled-thread-action-payload-store|durable-turn-request-store|acp-session-store|acp-available-commands-store|messaging-pairing-store|messaging-activity-log|operator-request-store|token-miser-storage-sqlite|acp-agent-store|messaging-request-store|messaging-store-sqlite|federation-store|thread-sandbox-store|claude-session-metadata-store|retained-owner-thread-store)\\.)|packages/sqlite-storage/|@pwragent/sqlite-storage(?:/|$))",
      },
    },
    {
      name: "desktop-raw-config-is-store-private",
      severity: "error",
      comment:
        "Only the desktop config-store implementation may import the raw config parser/writer.",
      from: {
        path: "^apps/desktop/src/main/",
        pathNot: "^apps/desktop/src/main/settings/config-store/",
      },
      to: {
        path: "^apps/desktop/src/main/settings/config-store/raw-config-file\\.ts$",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
      dependencyTypes: [
        "npm",
        "npm-dev",
        "npm-optional",
        "npm-peer",
        "npm-bundled",
        "npm-no-pkg",
      ],
    },
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
  },
};
