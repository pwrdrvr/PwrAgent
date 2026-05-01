#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

const DEFAULT_VAULT_NAME = "Private";
const DEFAULT_ITEM_NAME = "PwrAgnt Messaging";

const SECRET_FIELDS = [
  {
    field: "PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN",
    env: "PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN",
  },
  {
    field: "PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS",
    env: "PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS",
  },
  {
    field: "PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN",
    env: "PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN",
  },
  {
    field: "PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID",
    env: "PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID",
  },
  {
    field: "PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS",
    env: "PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS",
  },
];

function readSecret(reference) {
  return execFileSync("op", ["read", reference], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryReadSecret(reference) {
  try {
    const value = readSecret(reference);
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function loadOpEnv(env = process.env) {
  const vaultName = env.PWRAGNT_OP_VAULT ?? DEFAULT_VAULT_NAME;
  const itemName = env.PWRAGNT_OP_ITEM ?? DEFAULT_ITEM_NAME;
  const nextEnv = { ...env };
  let loadedCount = 0;

  for (const { env: envName, field } of SECRET_FIELDS) {
    const value = tryReadSecret(`op://${vaultName}/${itemName}/${field}`);
    if (!value) {
      continue;
    }

    nextEnv[envName] = value;
    loadedCount += 1;
  }

  if (loadedCount === 0) {
    throw new Error(
      [
        `No PwrAgnt messaging fields were loaded from 1Password item "${itemName}" in vault "${vaultName}".`,
        `Create that item or set PWRAGNT_OP_VAULT/PWRAGNT_OP_ITEM before running this command.`,
      ].join(" "),
    );
  }

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
        "Defaults:",
        `  PWRAGNT_OP_VAULT=${DEFAULT_VAULT_NAME}`,
        `  PWRAGNT_OP_ITEM=${DEFAULT_ITEM_NAME}`,
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
