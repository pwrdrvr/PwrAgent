module.exports = {
  forbidden: [
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
      name: "codex-protocol-is-a-leaf",
      severity: "error",
      comment:
        "packages/codex-app-server-protocol must not import any internal workspace package.",
      from: {
        path: "^packages/codex-app-server-protocol/",
      },
      to: {
        path: "^(@pwragent/|apps/|packages/(?!codex-app-server-protocol/))",
      },
    },
    {
      name: "agent-core-only-imports-shared",
      severity: "error",
      comment:
        "agent-core may only depend on packages/shared internally.",
      from: {
        path: "^packages/agent-core/",
      },
      to: {
        path: "^(@pwragent/(?!shared)|apps/|packages/(?!shared/|agent-core/))",
      },
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
        path: "^(@pwragent/(?!shared)|packages/(?!shared/))",
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
        path: "^(@pwragent/(agent-core|messaging-provider|codex-app-server-protocol|desktop)|apps/|packages/agent-core/|packages/codex-app-server-protocol/|packages/messaging/providers/)",
      },
    },
    {
      name: "messaging-providers-do-not-import-hosts",
      severity: "error",
      comment:
        "Messaging providers must be isolated packages; they cannot import desktop or agent-core internals.",
      from: {
        path: "^packages/messaging/providers/",
      },
      to: {
        path: "^(@pwragent/(agent-core|codex-app-server-protocol|desktop)|apps/|packages/agent-core/|packages/codex-app-server-protocol/)",
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
