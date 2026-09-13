/** Product identity is separate from the host stored in PrSummary.provider. */
export const FORGE_KINDS = ["github", "gitlab"] as const;
export type ForgeKind = typeof FORGE_KINDS[number];

type ForgeProduct = {
  label: string;
  cli: string;
  saasHost: string;
  changeRequest: string;
  changeRequestPath: string;
  pollBatchSize: number;
  nestedNamespaces: boolean;
  /** Compatibility policy for remote discovery, not proof of server identity. */
  remoteHostPrefix: string | undefined;
  configurableHost: boolean;
  signInGuide: string;
  install: { guide: string; darwin: string; win32: string } | undefined;
};

/** All product facts used by both processes belong here. Provider behavior
 * lives in exhaustive tables keyed by ForgeKind, never an else-GitHub fallback. */
export const FORGE_PRODUCTS = {
  github: {
    label: "GitHub",
    cli: "gh",
    saasHost: "github.com",
    changeRequest: "pull request",
    changeRequestPath: "pull",
    pollBatchSize: 40,
    nestedNamespaces: false,
    remoteHostPrefix: undefined,
    configurableHost: false,
    signInGuide: "https://cli.github.com/manual/gh_auth_login",
    install: undefined,
  },
  gitlab: {
    label: "GitLab",
    cli: "glab",
    saasHost: "gitlab.com",
    changeRequest: "merge request",
    changeRequestPath: "-/merge_requests",
    pollBatchSize: 1,
    nestedNamespaces: true,
    remoteHostPrefix: "gitlab.",
    configurableHost: true,
    signInGuide: "https://docs.gitlab.com/cli/authentication/",
    install: {
      guide: "https://gitlab.com/gitlab-org/cli/-/blob/main/docs/installation_options.md",
      darwin: "brew install glab",
      win32: "winget install --exact --id glab.glab",
    },
  },
} as const satisfies Record<ForgeKind, ForgeProduct>;

export type ForgeCli = typeof FORGE_PRODUCTS[ForgeKind]["cli"];

export function isForgeKind(value: unknown): value is ForgeKind {
  return FORGE_KINDS.some((kind) => kind === value);
}

export function forgeKindForRemoteHost(host: string): ForgeKind | undefined {
  const normalized = host.toLowerCase();
  return FORGE_KINDS.find((kind) => {
    const product = FORGE_PRODUCTS[kind];
    return normalized === product.saasHost
      || (product.remoteHostPrefix !== undefined && normalized.startsWith(product.remoteHostPrefix));
  });
}
