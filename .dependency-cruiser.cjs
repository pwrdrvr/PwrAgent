module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Messaging package and desktop messaging dependencies must stay acyclic.",
      from: {},
      to: {
        circular: true,
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
        path: "^(apps/|packages/agent-core/|packages/messaging/providers/)",
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
        path: "^(apps/|packages/agent-core/)",
      },
    },
    {
      name: "messaging-providers-use-interface-not-shared",
      severity: "error",
      comment:
        "Provider packages should depend on @pwragnt/messaging-interface, not shared app contracts directly.",
      from: {
        path: "^packages/messaging/providers/",
      },
      to: {
        path: "^packages/shared/",
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
        path: "^packages/messaging/providers/",
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
        path: "^packages/messaging/providers/",
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
