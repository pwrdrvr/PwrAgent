#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const USAGE = `Usage:
  analyze_rollout_tool_output.mjs [options] <rollout.jsonl | dir> [...]
  analyze_rollout_tool_output.mjs --thread-id <uuid> [--profile <name>]

Options:
  --thread-id <uuid>       Search Codex session trees for rollout files containing this id.
  --profile <name>         Include ~/.codex/profiles/<name>/sessions and archived_sessions.
  --json                   Emit full JSON instead of Markdown.
  --top <n>                Rows per table (default: 15).
  --max-files <n>          Stop thread-id search after n matching files (default: 20).
  --help                   Show this help.
`;

function parseArgs(argv) {
  const args = {
    json: false,
    maxFiles: 20,
    paths: [],
    profile: undefined,
    threadId: undefined,
    top: 15,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--thread-id") {
      args.threadId = argv[++index];
      continue;
    }
    if (arg === "--profile") {
      args.profile = argv[++index];
      continue;
    }
    if (arg === "--top") {
      args.top = Number(argv[++index]);
      continue;
    }
    if (arg === "--max-files") {
      args.maxFiles = Number(argv[++index]);
      continue;
    }
    args.paths.push(arg);
  }
  return args;
}

function walkJsonlFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return root.endsWith(".jsonl") ? [root] : [];
  }
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  return files;
}

function defaultSearchRoots(profile) {
  const home = os.homedir();
  const roots = [
    path.join(home, ".codex", "sessions"),
    path.join(home, ".codex", "archived_sessions"),
  ];
  if (profile) {
    roots.unshift(
      path.join(home, ".codex", "profiles", profile, "sessions"),
      path.join(home, ".codex", "profiles", profile, "archived_sessions"),
    );
  } else {
    const profilesRoot = path.join(home, ".codex", "profiles");
    if (fs.existsSync(profilesRoot)) {
      for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          roots.unshift(
            path.join(profilesRoot, entry.name, "sessions"),
            path.join(profilesRoot, entry.name, "archived_sessions"),
          );
        }
      }
    }
  }
  return roots;
}

function findRolloutsByThreadId(threadId, profile, maxFiles) {
  const matches = [];
  const seen = new Set();
  const candidates = [];
  for (const root of defaultSearchRoots(profile)) {
    for (const file of walkJsonlFiles(root)) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      candidates.push(file);
      if (path.basename(file).includes(threadId)) {
        matches.push(file);
        if (matches.length >= maxFiles) {
          return matches;
        }
      }
    }
  }
  for (const file of candidates) {
    if (matches.includes(file)) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(threadId)) {
      matches.push(file);
      if (matches.length >= maxFiles) {
        return matches;
      }
    }
  }
  return matches;
}

function estimateTokens(text) {
  return text ? Math.ceil(text.length / 4) : 0;
}

function parseJson(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function startsShellCommand(trimmed, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[;&|]\\s*)([A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*(\\S+/)?${escaped}(\\s|$)`).test(trimmed);
}

function firstShellWord(trimmed) {
  const match = trimmed.match(/(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(\S+)/);
  return match?.[2] || "";
}

function normalizeCommand(command, toolName) {
  const trimmed = (command || "").trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return toolName || "unknown";
  }
  if (startsShellCommand(trimmed, "sbt")) {
    return "sbt";
  }
  if (startsShellCommand(trimmed, "git") && /\bgit\s+diff\b/.test(trimmed)) {
    return "git diff";
  }
  if (startsShellCommand(trimmed, "git")) {
    const gitMatch = trimmed.match(/\bgit\s+(\S+)/);
    return `git ${gitMatch?.[1] || "command"}`;
  }
  if (startsShellCommand(trimmed, "pnpm")) {
    const parts = trimmed.split(/\s+/);
    const script = parts.find((part) => /^((test|lint|typecheck|build)(:|$)|eslint$)/.test(part));
    return script ? `pnpm ${script}` : "pnpm";
  }
  if (startsShellCommand(trimmed, "rg")) {
    return "rg";
  }
  if (startsShellCommand(trimmed, "sed")) {
    return "sed";
  }
  if (startsShellCommand(trimmed, "find")) {
    return "find";
  }
  for (const name of ["tail", "head", "nl", "cat", "sqlite3"]) {
    if (startsShellCommand(trimmed, name)) {
      return name;
    }
  }
  if (startsShellCommand(trimmed, "log") || startsShellCommand(trimmed, "/usr/bin/log")) {
    return "log show";
  }
  const first = firstShellWord(trimmed) || toolName || "unknown";
  return first.replace(/^.*\//, "");
}

function classifyOutput(output) {
  const lines = output ? output.split("\n") : [];
  const nonblank = lines.filter((line) => line.trim() !== "");
  return {
    debugInfoLines: lines.filter((line) => /\b(debug|info|trace|verbose)\b/i.test(line)).length,
    duplicateLines: Math.max(0, nonblank.length - new Set(nonblank).size),
    errorLines: lines.filter((line) => /\b(error|failed|failure|exception|aborted)\b/i.test(line)).length,
    lines: output ? lines.length : 0,
    warningLines: lines.filter((line) => /\b(warn|warning)\b/i.test(line)).length,
  };
}

function parseToolOutputEnvelope(output) {
  const exitCode = output.match(/Process exited with code (-?\d+)/)?.[1];
  const runningSessionId = output.match(/Process running with session ID (\d+)/)?.[1];
  const originalTokenCount = output.match(/Original token count: (\d+)/)?.[1];
  const truncatedTokenCount = output.match(/Warning: truncated output \(original token count: (\d+)\)/)?.[1];
  return {
    exitCode: exitCode === undefined ? undefined : Number(exitCode),
    originalTokenCount: originalTokenCount === undefined ? undefined : Number(originalTokenCount),
    runningSessionId,
    truncated: /Warning: truncated output/.test(output),
    truncatedTokenCount: truncatedTokenCount === undefined ? undefined : Number(truncatedTokenCount),
  };
}

function readRecords(file) {
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { index, record: JSON.parse(line) };
      } catch (error) {
        return { error: String(error), index, record: undefined };
      }
    });
}

function analyzeRollout(file) {
  const rows = readRecords(file);
  const calls = new Map();
  const outputs = [];
  const sessionCommands = new Map();
  const tokenCounts = [];
  const userMessages = [];
  let meta;

  for (const { index, record } of rows) {
    const payload = record?.payload;
    if (!meta && record?.type === "session_meta") {
      meta = payload;
    }
    if (record?.type === "event_msg" && payload?.type === "user_message") {
      userMessages.push({ index, text: payload.message || "", timestamp: record.timestamp });
    }
    if (record?.type === "event_msg" && payload?.type === "token_count") {
      tokenCounts.push({
        index,
        inputTokens: payload.info?.last_token_usage?.input_tokens || 0,
        timestamp: record.timestamp,
        totalCachedInputTokens: payload.info?.total_token_usage?.cached_input_tokens || 0,
        totalInputTokens: payload.info?.total_token_usage?.input_tokens || 0,
      });
    }
    if (record?.type === "response_item" && payload?.type === "function_call") {
      const parsedArgs = parseJson(payload.arguments);
      const command = parsedArgs?.cmd || parsedArgs?.command || "";
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
      calls.set(payload.call_id, {
        args: parsedArgs,
        callId: payload.call_id,
        command,
        index,
        name: payload.name,
        normalizedCommand: normalizeCommand(command, payload.name),
        timestamp: record.timestamp,
        turnId,
      });
    }
    if (record?.type === "response_item" && payload?.type === "function_call_output") {
      const call = calls.get(payload.call_id);
      const output = payload.output || "";
      const envelope = parseToolOutputEnvelope(output);
      if (envelope.runningSessionId && call?.command) {
        sessionCommands.set(String(envelope.runningSessionId), {
          command: call.command,
          normalizedCommand: call.normalizedCommand,
          startedAt: call.timestamp,
          turnId: call.turnId,
        });
      }
      let normalizedCommand = call?.normalizedCommand || call?.name || "unknown";
      let command = call?.command || "";
      let pollSessionId;
      if (call?.name === "write_stdin" && call.args?.session_id !== undefined) {
        pollSessionId = String(call.args.session_id);
        const parent = sessionCommands.get(pollSessionId);
        if (parent) {
          normalizedCommand = `${parent.normalizedCommand} (poll)`;
          command = parent.command;
        } else {
          normalizedCommand = "write_stdin";
        }
      }
      outputs.push({
        ...classifyOutput(output),
        ...envelope,
        callId: payload.call_id,
        command,
        index,
        modelRequestsAfter: 0,
        name: call?.name || "unknown",
        normalizedCommand,
        outputChars: output.length,
        outputTokens: estimateTokens(output),
        pollSessionId,
        replayInputImpressions: 0,
        timestamp: record.timestamp,
        turnId: call?.turnId,
      });
    }
  }

  for (const output of outputs) {
    output.modelRequestsAfter = tokenCounts.filter((entry) => entry.index > output.index).length;
    output.replayInputImpressions = output.outputTokens * output.modelRequestsAfter;
  }

  return buildSummary(file, meta, userMessages, tokenCounts, calls, outputs);
}

function emptyGroup(command) {
  return {
    chars: 0,
    command,
    calls: 0,
    debugInfoLines: 0,
    duplicateLines: 0,
    errorLines: 0,
    exits: {},
    lines: 0,
    replayInputImpressions: 0,
    tokens: 0,
    truncatedOutputs: 0,
    warningLines: 0,
  };
}

function buildSummary(file, meta, userMessages, tokenCounts, calls, outputs) {
  const groups = new Map();
  const byTurn = new Map();
  const polls = new Map();
  for (const output of outputs) {
    const group = groups.get(output.normalizedCommand) || emptyGroup(output.normalizedCommand);
    group.calls += 1;
    group.chars += output.outputChars;
    group.debugInfoLines += output.debugInfoLines;
    group.duplicateLines += output.duplicateLines;
    group.errorLines += output.errorLines;
    group.lines += output.lines;
    group.replayInputImpressions += output.replayInputImpressions;
    group.tokens += output.outputTokens;
    group.truncatedOutputs += output.truncated ? 1 : 0;
    group.warningLines += output.warningLines;
    if (output.exitCode !== undefined) {
      group.exits[output.exitCode] = (group.exits[output.exitCode] || 0) + 1;
    }
    groups.set(output.normalizedCommand, group);

    const turnKey = output.turnId || "unknown";
    const turn = byTurn.get(turnKey) || emptyGroup(turnKey);
    turn.calls += 1;
    turn.chars += output.outputChars;
    turn.debugInfoLines += output.debugInfoLines;
    turn.errorLines += output.errorLines;
    turn.lines += output.lines;
    turn.replayInputImpressions += output.replayInputImpressions;
    turn.tokens += output.outputTokens;
    turn.warningLines += output.warningLines;
    byTurn.set(turnKey, turn);

    if (output.pollSessionId) {
      const poll = polls.get(output.pollSessionId) || {
        chars: 0,
        command: output.command,
        count: 0,
        firstAt: output.timestamp,
        intervalsMs: [],
        lastAt: output.timestamp,
        normalizedCommand: output.normalizedCommand,
        outputs: [],
        tokens: 0,
      };
      const previousTime = Date.parse(poll.lastAt);
      const currentTime = Date.parse(output.timestamp);
      if (Number.isFinite(previousTime) && Number.isFinite(currentTime) && poll.count > 0) {
        poll.intervalsMs.push(currentTime - previousTime);
      }
      poll.count += 1;
      poll.chars += output.outputChars;
      poll.tokens += output.outputTokens;
      poll.lastAt = output.timestamp;
      poll.outputs.push(output);
      polls.set(output.pollSessionId, poll);
    }
  }

  const noisyPolls = [...polls.entries()]
    .map(([sessionId, poll]) => {
      const near30s = poll.intervalsMs.filter((ms) => ms >= 25_000 && ms <= 35_000).length;
      return {
        chars: poll.chars,
        command: poll.command,
        count: poll.count,
        firstAt: poll.firstAt,
        lastAt: poll.lastAt,
        near30sIntervals: near30s,
        normalizedCommand: poll.normalizedCommand,
        sessionId,
        tokens: poll.tokens,
      };
    })
    .filter((poll) => poll.count >= 2 && (poll.near30sIntervals >= 1 || poll.chars >= 20_000))
    .sort((left, right) => right.tokens - left.tokens);

  const lastToken = tokenCounts.at(-1);
  return {
    file,
    meta: {
      cwd: meta?.cwd,
      firstUser: (userMessages[0]?.text || "").replace(/\s+/g, " ").slice(0, 220),
      gitBranch: meta?.git?.branch,
      sessionId: meta?.session_id || meta?.id,
    },
    noisyPolls,
    topGroups: [...groups.values()].sort((left, right) => right.tokens - left.tokens),
    topOutputs: outputs
      .slice()
      .sort((left, right) => right.outputTokens - left.outputTokens)
      .slice(0, 50)
      .map((output) => ({
        chars: output.outputChars,
        command: output.normalizedCommand,
        commandPreview: output.command.replace(/\s+/g, " ").slice(0, 220),
        exitCode: output.exitCode,
        lineStats: {
          debugInfo: output.debugInfoLines,
          duplicate: output.duplicateLines,
          errors: output.errorLines,
          lines: output.lines,
          warnings: output.warningLines,
        },
        modelRequestsAfter: output.modelRequestsAfter,
        originalTokenCount: output.originalTokenCount,
        pollSessionId: output.pollSessionId,
        replayInputImpressions: output.replayInputImpressions,
        timestamp: output.timestamp,
        tokens: output.outputTokens,
        truncated: output.truncated,
        turnId: output.turnId,
      })),
    topReplayOutputs: outputs
      .slice()
      .sort((left, right) => right.replayInputImpressions - left.replayInputImpressions)
      .slice(0, 50)
      .map((output) => ({
        chars: output.outputChars,
        command: output.normalizedCommand,
        commandPreview: output.command.replace(/\s+/g, " ").slice(0, 220),
        modelRequestsAfter: output.modelRequestsAfter,
        replayInputImpressions: output.replayInputImpressions,
        timestamp: output.timestamp,
        tokens: output.outputTokens,
        turnId: output.turnId,
      })),
    topTurns: [...byTurn.values()].sort((left, right) => right.tokens - left.tokens),
    totals: {
      fileBytes: fs.statSync(file).size,
      functionCalls: calls.size,
      functionOutputs: outputs.length,
      outputChars: outputs.reduce((sum, output) => sum + output.outputChars, 0),
      outputTokens: outputs.reduce((sum, output) => sum + output.outputTokens, 0),
      replayInputImpressions: outputs.reduce((sum, output) => sum + output.replayInputImpressions, 0),
      tokenCountEvents: tokenCounts.length,
      totalCachedInputTokens: lastToken?.totalCachedInputTokens || 0,
      totalInputTokens: lastToken?.totalInputTokens || 0,
      truncatedOutputs: outputs.filter((output) => output.truncated).length,
    },
  };
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function markdownTable(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.map((cell) => String(cell).replace(/\n/g, " ")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderMarkdown(summaries, top) {
  const out = [];
  for (const summary of summaries) {
    out.push(`## ${summary.meta.sessionId || path.basename(summary.file)}`);
    out.push("");
    out.push(`File: \`${summary.file}\``);
    if (summary.meta.cwd) {
      out.push(`Cwd: \`${summary.meta.cwd}\``);
    }
    if (summary.meta.firstUser) {
      out.push(`First user message: ${summary.meta.firstUser}`);
    }
    out.push("");
    out.push(`Totals: ${formatNumber(summary.totals.functionOutputs)} outputs, ${formatNumber(summary.totals.outputChars)} chars, ~${formatNumber(summary.totals.outputTokens)} output tokens, ${formatNumber(summary.totals.truncatedOutputs)} truncated outputs, ${formatNumber(summary.totals.tokenCountEvents)} token-count events.`);
    out.push("");
    out.push("### Tool Output By Command");
    out.push(markdownTable(
      ["Command", "Calls", "Chars", "Est Tokens", "Warnings", "Errors", "Info/Debug", "Truncated"],
      summary.topGroups.slice(0, top).map((group) => [
        `\`${group.command}\``,
        formatNumber(group.calls),
        formatNumber(group.chars),
        formatNumber(group.tokens),
        formatNumber(group.warningLines),
        formatNumber(group.errorLines),
        formatNumber(group.debugInfoLines),
        formatNumber(group.truncatedOutputs),
      ]),
    ));
    out.push("");
    if (summary.noisyPolls.length > 0) {
      out.push("### Noisy Polling Candidates");
      out.push(markdownTable(
        ["Session", "Polls", "Command", "Chars", "Est Tokens", "~30s Intervals"],
        summary.noisyPolls.slice(0, top).map((poll) => [
          `\`${poll.sessionId}\``,
          formatNumber(poll.count),
          `\`${poll.normalizedCommand}\``,
          formatNumber(poll.chars),
          formatNumber(poll.tokens),
          formatNumber(poll.near30sIntervals),
        ]),
      ));
      out.push("");
    }
    out.push("### Largest Outputs");
    out.push(markdownTable(
      ["Time", "Turn", "Command", "Chars", "Est Tokens", "Exit", "Preview"],
      summary.topOutputs.slice(0, top).map((entry) => [
        entry.timestamp,
        entry.turnId ? `\`${entry.turnId.slice(0, 8)}\`` : "",
        `\`${entry.command}\``,
        formatNumber(entry.chars),
        formatNumber(entry.tokens),
        entry.exitCode ?? "",
        entry.commandPreview ? `\`${entry.commandPreview}\`` : "",
      ]),
    ));
    out.push("");
  }
  return out.join("\n");
}

const args = parseArgs(process.argv.slice(2));
let files = [];
if (args.threadId) {
  files = findRolloutsByThreadId(args.threadId, args.profile, args.maxFiles);
}
for (const inputPath of args.paths) {
  files.push(...walkJsonlFiles(path.resolve(inputPath)));
}
files = [...new Set(files)];
if (files.length === 0) {
  console.error("No rollout JSONL files found.");
  console.error(USAGE);
  process.exit(1);
}

const summaries = files.map((file) => analyzeRollout(file));
if (args.json) {
  console.log(JSON.stringify({ summaries }, null, 2));
} else {
  console.log(renderMarkdown(summaries, args.top));
}
