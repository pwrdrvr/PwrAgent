#!/usr/bin/env node
/**
 * Wrapper that loads PwrAgent secrets from a 1Password item before
 * launching a child process. Keeps tokens and provider IDs out of shell
 * history and out of `~/.bash_sessions`.
 *
 * Default vault: "Private". Default item: "PwrAgent". Override with
 * `PWRAGENT_OP_VAULT` and/or `PWRAGENT_OP_ITEM` if you store the secret
 * elsewhere (older setups used a separate "PwrAgent Messaging" item;
 * point the env vars at it to keep using the same wrapper).
 *
 * Field discovery: every field on the item whose label matches
 * /^PWRAGENT_[A-Z0-9_]+$/ is copied into the child's environment under
 * that exact name. Add a new env-var field to the 1Password item and it
 * picks up automatically — no script edits needed.
 *
 * Auto-enablement: when a provider's required env vars are all present,
 * the corresponding `PWRAGENT_MESSAGING_<PROVIDER>_ENABLED=true` is set
 * automatically (skipped if you've already set ENABLED explicitly to
 * something — including "false"). The provider list is data-driven; add
 * a new entry to PROVIDER_AUTO_ENABLE below as new providers land.
 */
import { execFileSync, spawn } from "node:child_process";

const DEFAULT_VAULT_NAME = "Private";
const DEFAULT_ITEM_NAME = "PwrAgent";

/**
 * Map: provider name → list of env vars that must all be present before
 * we set its `*_ENABLED=true` flag automatically. A user can opt out by
 * setting ENABLED=false in env or in the 1Password item.
 */
const PROVIDER_AUTO_ENABLE = [
  {
    name: "telegram",
    enabledVar: "PWRAGENT_MESSAGING_TELEGRAM_ENABLED",
    requiredVars: [
      "PWRAGENT_MESSAGING_TELEGRAM_BOT_TOKEN",
      "PWRAGENT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS",
    ],
  },
  {
    name: "discord",
    enabledVar: "PWRAGENT_MESSAGING_DISCORD_ENABLED",
    requiredVars: [
      "PWRAGENT_MESSAGING_DISCORD_BOT_TOKEN",
      "PWRAGENT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS",
    ],
  },
  {
    name: "mattermost",
    enabledVar: "PWRAGENT_MESSAGING_MATTERMOST_ENABLED",
    requiredVars: [
      "PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN",
      "PWRAGENT_MESSAGING_MATTERMOST_SERVER_URL",
      "PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_BASE_URL",
      "PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_USER_IDS",
    ],
  },
];

function fetchOpItem(vaultName, itemName) {
  let raw;
  try {
    raw = execFileSync(
      "op",
      ["item", "get", itemName, "--vault", vaultName, "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Failed to read 1Password item "${itemName}" from vault "${vaultName}".`,
        "Confirm the item exists and that you've approved the request in the 1Password app.",
        `Underlying error: ${message}`,
      ].join(" "),
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `1Password CLI returned non-JSON output for ${itemName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readSecretReference(reference) {
  try {
    const value = execFileSync("op", ["read", reference], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function loadOpEnv(env = process.env) {
  const vaultName = env.PWRAGENT_OP_VAULT ?? DEFAULT_VAULT_NAME;
  const itemName = env.PWRAGENT_OP_ITEM ?? DEFAULT_ITEM_NAME;
  const item = fetchOpItem(vaultName, itemName);
  const fields = Array.isArray(item.fields) ? item.fields : [];
  const nextEnv = { ...env };
  const loadedNames = [];

  for (const field of fields) {
    const label = typeof field?.label === "string" ? field.label : field?.id;
    if (typeof label !== "string") continue;
    if (!/^PWRAGENT_[A-Z0-9_]+$/.test(label)) continue;

    let value =
      typeof field.value === "string" && field.value.length > 0
        ? field.value
        : undefined;

    // Concealed (password) fields sometimes need an explicit `op read`
    // reference even with `--format json`. Fall back to that path.
    if (!value) {
      value = readSecretReference(`op://${vaultName}/${itemName}/${label}`);
    }
    if (!value) continue;

    if (env[label] === undefined) {
      nextEnv[label] = value;
      loadedNames.push(label);
    }
  }

  if (loadedNames.length === 0) {
    throw new Error(
      [
        `No PWRAGENT_* fields were loaded from "${itemName}" in vault "${vaultName}".`,
        "Add one or more fields whose names start with PWRAGENT_ (e.g.,",
        "PWRAGENT_MESSAGING_TELEGRAM_BOT_TOKEN), or override with",
        "PWRAGENT_OP_VAULT / PWRAGENT_OP_ITEM if your secret lives elsewhere.",
      ].join(" "),
    );
  }

  for (const provider of PROVIDER_AUTO_ENABLE) {
    if (env[provider.enabledVar] !== undefined) continue;
    const allPresent = provider.requiredVars.every(
      (name) => typeof nextEnv[name] === "string" && nextEnv[name].length > 0,
    );
    if (allPresent) {
      nextEnv[provider.enabledVar] = "true";
    }
  }

  process.stderr.write(
    `op-run: loaded ${loadedNames.length} field${
      loadedNames.length === 1 ? "" : "s"
    } from "${itemName}" (vault "${vaultName}"): ${loadedNames.sort().join(", ")}\n`,
  );

  return nextEnv;
}

function runWithEnv(command, args, env = process.env) {
  const child = spawn(command, args, {
    env: loadOpEnv(env),
    shell: false,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(
      [
        "Usage:",
        "  node scripts/op-run.mjs dev",
        "  node scripts/op-run.mjs run -- <command> [args...]",
        "",
        "Defaults (override via env):",
        `  PWRAGENT_OP_VAULT=${DEFAULT_VAULT_NAME}`,
        `  PWRAGENT_OP_ITEM=${DEFAULT_ITEM_NAME}`,
        "",
        "Discovers any field on the 1Password item whose label matches",
        "/^PWRAGENT_[A-Z0-9_]+$/ and exports it into the child env.",
        "",
        "Auto-enables messaging providers when all required vars are set.",
        "",
      ].join("\n"),
    );
    return;
  }

  if (mode === "dev") {
    runWithEnv("pnpm", ["dev"]);
    return;
  }

  if (mode === "run") {
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    if (args.length === 0) {
      throw new Error(
        "Missing command. Example: node scripts/op-run.mjs run -- pnpm dev",
      );
    }
    runWithEnv(args[0], args.slice(1));
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
