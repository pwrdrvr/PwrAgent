import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubEnterpriseDiscovery, GithubEnterpriseServer } from "@pwragent/shared/contracts/settings";
import {
  isGithubEnterpriseLogin,
  MIN_GH_ENTERPRISE_DISCOVERY_MINOR,
  normalizeGithubEnterpriseHost,
} from "@pwragent/shared/github-enterprise-hosts";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverGhCommands } from "../settings/gh-discovery";

const execFileAsync = promisify(execFile);
const ENTERPRISE_TOKEN_NAMES = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

type RunGh = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const runGh: RunGh = async (command, args, env) => (await execFileAsync(command, args, {
  env, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true,
})).stdout;

function exactHost(value: unknown): string | undefined {
  const host = normalizeGithubEnterpriseHost(value);
  return host && URL.parse(`https://${host}`)?.host === host ? host : undefined;
}

function ghEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = buildPwrAgentChildProcessEnv(env);
  for (const key of Object.keys(clean)) {
    if (["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG", "GH_PROMPT_DISABLED"].includes(key.toUpperCase())) {
      delete clean[key];
    }
  }
  return { ...clean, GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "", GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
}

function environmentCredential(host: string, env: NodeJS.ProcessEnv) {
  if (exactHost(env.GH_HOST) !== host) return undefined;
  const name = ENTERPRISE_TOKEN_NAMES.find((key) => env[key]?.trim());
  return name ? { name, token: env[name]!.trim() } : undefined;
}

/** Export one exact identity. A pin suppresses all environment credentials and fallback. */
export async function readEnterpriseGithubToken(
  command: string,
  host: string,
  login: string | undefined,
  env = process.env,
  run: RunGh = runGh,
): Promise<string | null> {
  if (exactHost(host) !== host || (login !== undefined && !isGithubEnterpriseLogin(login))) return null;
  if (login === undefined) {
    const credential = environmentCredential(host, env);
    if (credential) return credential.token;
  }
  try {
    return (await run(command, [
      "auth", "token", "--hostname", host, ...(login === undefined ? [] : ["--user", login]),
    ], ghEnvironment(env))).trim() || null;
  } catch {
    // Subprocess errors can contain credential output. Never surface them.
    return null;
  }
}

export function parseGithubEnterpriseAuthStatus(stdout: string): GithubEnterpriseServer[] {
  const payload = JSON.parse(stdout) as { hosts?: Record<string, unknown> | null };
  if (!payload || !Object.hasOwn(payload, "hosts") || (payload.hosts !== null
    && (!payload.hosts || typeof payload.hosts !== "object" || Array.isArray(payload.hosts)))) {
    throw new Error("GitHub CLI returned an invalid auth status.");
  }
  return Object.entries(payload.hosts ?? {}).flatMap(([key, entries]) => {
    const host = exactHost(key);
    if (!host || !Array.isArray(entries)) return [];
    const accounts = new Set<string>();
    let activeLogin: string | undefined;
    for (const account of entries as Array<{ login?: unknown; active?: unknown; state?: unknown } | null>) {
      if (account?.state !== "success" || !isGithubEnterpriseLogin(account.login)) continue;
      accounts.add(account.login);
      if (account.active === true) activeLogin = account.login;
    }
    return [{ host, accounts: [...accounts], activeLogin }];
  });
}

export async function discoverGithubEnterpriseAccounts(configuredCommand?: string): Promise<GithubEnterpriseDiscovery> {
  const env = process.env;
  const discovery = await discoverGhCommands({ configuredCommand });
  const command = discovery.selectedCommand;
  if (!command) return { state: "missing", servers: [] };
  const version = discovery.candidates.find((candidate) => candidate.selected)?.version;
  const match = version?.match(/^(\d+)\.(\d+)/);
  if (match && (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < MIN_GH_ENTERPRISE_DISCOVERY_MINOR))) {
    return { state: "upgrade", servers: [] };
  }

  const args = ["auth", "status", "--json", "hosts"];
  const clean = ghEnvironment(env);
  try {
    const servers = parseGithubEnterpriseAuthStatus(await runGh(command, args, clean));
    const host = exactHost(env.GH_HOST);
    const credential = host && environmentCredential(host, env);
    if (host && credential) {
      const stored = servers.find((server) => server.host === host);
      // A broad status check must never inherit an enterprise environment token.
      const scoped = await runGh(command, [...args, "--hostname", host], {
        ...clean, GH_HOST: host, [credential.name]: credential.token,
      }).then(parseGithubEnterpriseAuthStatus).catch(() => []);
      const override = scoped.find((server) => server.host === host);
      const server = { host, accounts: stored?.accounts ?? [], activeLogin: override?.activeLogin, environmentToken: credential.name };
      if (stored) servers[servers.indexOf(stored)] = server;
      else servers.push(server);
    }
    return { state: "ready", servers };
  } catch {
    return { state: "unavailable", servers: [] };
  }
}
