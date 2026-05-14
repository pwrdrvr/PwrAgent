import fs from "node:fs/promises";
import path from "node:path";

export type CpuProfile = {
  nodes: Array<{
    id: number;
    callFrame: {
      functionName: string;
      scriptId?: string;
      url: string;
      lineNumber?: number;
      columnNumber?: number;
    };
    children?: number[];
  }>;
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
};

type CpuProfileProcess = "main" | "renderer";

type RankedFunction = {
  columnNumber?: number;
  functionName: string;
  lineNumber?: number;
  sourceBucket: string;
  selfMicros: number;
  totalMicros: number;
};

type RankedSource = {
  sourceBucket: string;
  selfMicros: number;
  totalMicros: number;
};

export type StartupCpuProcessAnalysis = {
  process: CpuProfileProcess;
  durationMicros: number;
  topFunctionsBySelf: RankedFunction[];
  topFunctionsByTotal: RankedFunction[];
  topSourcesBySelf: RankedSource[];
  topSourcesByTotal: RankedSource[];
};

export type StartupCpuSessionAnalysis = {
  generatedAt: string;
  sessionDirectoryName: string;
  sessionDirectoryPath: string;
  analysisPath: string;
  summaryPath: string;
  results: StartupCpuProcessAnalysis[];
};

export function analyzeCpuProfile(params: {
  process: CpuProfileProcess;
  profile: CpuProfile;
  repoRoot: string;
  desktopRoot: string;
}): StartupCpuProcessAnalysis {
  const parentById = new Map<number, number>();
  const nodeById = new Map(params.profile.nodes.map((node) => [node.id, node]));

  for (const node of params.profile.nodes) {
    for (const childId of node.children ?? []) {
      parentById.set(childId, node.id);
    }
  }

  const selfMicrosByNodeId = new Map<number, number>();
  const totalMicrosByNodeId = new Map<number, number>();
  const samples = params.profile.samples ?? [];
  const timeDeltas = params.profile.timeDeltas ?? [];

  let durationMicros = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const nodeId = samples[index];
    const delta = timeDeltas[index] ?? 0;
    durationMicros += delta;
    selfMicrosByNodeId.set(nodeId, (selfMicrosByNodeId.get(nodeId) ?? 0) + delta);

    let currentNodeId: number | undefined = nodeId;
    while (currentNodeId !== undefined) {
      totalMicrosByNodeId.set(
        currentNodeId,
        (totalMicrosByNodeId.get(currentNodeId) ?? 0) + delta,
      );
      currentNodeId = parentById.get(currentNodeId);
    }
  }

  const functionRankings = new Map<string, RankedFunction>();
  const sourceRankings = new Map<string, RankedSource>();

  for (const [nodeId, node] of nodeById.entries()) {
    const selfMicros = selfMicrosByNodeId.get(nodeId) ?? 0;
    const totalMicros = totalMicrosByNodeId.get(nodeId) ?? 0;
    if (selfMicros === 0 && totalMicros === 0) {
      continue;
    }

    const sourceBucket = normalizeSourceBucket({
      url: node.callFrame.url,
      repoRoot: params.repoRoot,
      desktopRoot: params.desktopRoot,
    });

    const functionName = node.callFrame.functionName?.trim() || "(anonymous)";
    const lineNumber = normalizeLocationNumber(node.callFrame.lineNumber);
    const columnNumber = normalizeLocationNumber(node.callFrame.columnNumber);
    const functionKey = [
      functionName,
      sourceBucket,
      lineNumber ?? "",
      columnNumber ?? "",
    ].join("\u0000");
    const existingFunction = functionRankings.get(functionKey) ?? {
      functionName,
      sourceBucket,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(columnNumber !== undefined ? { columnNumber } : {}),
      selfMicros: 0,
      totalMicros: 0,
    };
    existingFunction.selfMicros += selfMicros;
    existingFunction.totalMicros += totalMicros;
    functionRankings.set(functionKey, existingFunction);

    const existingSource = sourceRankings.get(sourceBucket) ?? {
      sourceBucket,
      selfMicros: 0,
      totalMicros: 0,
    };
    existingSource.selfMicros += selfMicros;
    existingSource.totalMicros += totalMicros;
    sourceRankings.set(sourceBucket, existingSource);
  }

  return {
    process: params.process,
    durationMicros,
    topFunctionsBySelf: [...functionRankings.values()]
      .sort((left, right) => right.selfMicros - left.selfMicros)
      .slice(0, 10),
    topFunctionsByTotal: [...functionRankings.values()]
      .sort((left, right) => right.totalMicros - left.totalMicros)
      .slice(0, 10),
    topSourcesBySelf: [...sourceRankings.values()]
      .sort((left, right) => right.selfMicros - left.selfMicros)
      .slice(0, 10),
    topSourcesByTotal: [...sourceRankings.values()]
      .sort((left, right) => right.totalMicros - left.totalMicros)
      .slice(0, 10),
  };
}

function normalizeLocationNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && value >= 0 ? value : undefined;
}

export function renderStartupCpuAnalysisSummary(params: {
  sessionDirectoryName: string;
  results: StartupCpuProcessAnalysis[];
}): string {
  const lines = [
    "# Startup CPU Analysis",
    "",
    `Session: \`${params.sessionDirectoryName}\``,
    "",
  ];

  for (const result of params.results) {
    lines.push(`## ${formatProcessHeading(result.process)}`);
    lines.push("");
    lines.push(`Captured duration: ${formatMicros(result.durationMicros)}`);
    lines.push("");
    lines.push("Top functions by self time:");
    for (const entry of result.topFunctionsBySelf.slice(0, 5)) {
      const location =
        entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : "";
      lines.push(
        `- \`${entry.functionName}\` in \`${entry.sourceBucket}${location}\` — self ${formatMicros(
          entry.selfMicros,
        )}, total ${formatMicros(entry.totalMicros)}`,
      );
    }
    lines.push("");
    lines.push("Top source buckets by self time:");
    for (const entry of result.topSourcesBySelf.slice(0, 5)) {
      lines.push(
        `- \`${entry.sourceBucket}\` — self ${formatMicros(entry.selfMicros)}, total ${formatMicros(
          entry.totalMicros,
        )}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function analyzeStartupCpuProfileSession(options: {
  sessionDirectoryPath: string;
  repoRoot: string;
  analysisPath: string;
  summaryPath: string;
}): Promise<StartupCpuSessionAnalysis> {
  const desktopRoot = path.join(options.repoRoot, "apps/desktop");
  const results: StartupCpuProcessAnalysis[] = [];

  const mainProfile = await readOptionalCpuProfile(
    path.join(options.sessionDirectoryPath, "main.cpuprofile"),
  );
  if (mainProfile) {
    results.push(
      analyzeCpuProfile({
        process: "main",
        profile: mainProfile,
        repoRoot: options.repoRoot,
        desktopRoot,
      }),
    );
  }

  const rendererProfile = await readOptionalCpuProfile(
    path.join(options.sessionDirectoryPath, "renderer.cpuprofile"),
  );
  if (rendererProfile) {
    results.push(
      analyzeCpuProfile({
        process: "renderer",
        profile: rendererProfile,
        repoRoot: options.repoRoot,
        desktopRoot,
      }),
    );
  }

  if (results.length === 0) {
    throw new Error("No startup CPU profile artifacts found in session directory");
  }

  const analysis: StartupCpuSessionAnalysis = {
    generatedAt: new Date().toISOString(),
    sessionDirectoryName: path.basename(options.sessionDirectoryPath),
    sessionDirectoryPath: options.sessionDirectoryPath,
    analysisPath: options.analysisPath,
    summaryPath: options.summaryPath,
    results,
  };

  await fs.writeFile(options.analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  await fs.writeFile(
    options.summaryPath,
    renderStartupCpuAnalysisSummary({
      sessionDirectoryName: analysis.sessionDirectoryName,
      results: analysis.results,
    }),
    "utf8",
  );

  return analysis;
}

function formatProcessHeading(process: CpuProfileProcess): string {
  return process === "main" ? "Main Process" : "Renderer Process";
}

function formatMicros(value: number): string {
  return `${(value / 1000).toFixed(2)} ms`;
}

function normalizeSourceBucket(params: {
  url: string;
  repoRoot: string;
  desktopRoot: string;
}): string {
  const value = params.url?.trim();
  if (!value) {
    return "(unmapped)";
  }

  if (value.startsWith("electron/js2c")) {
    return "electron/js2c";
  }

  if (value.startsWith("node:")) {
    return value;
  }

  if (value.includes("node:internal") || value.includes("/node:internal/")) {
    return "node:internal";
  }

  if (value.startsWith("file://")) {
    const filePath = decodeFileUrl(value);
    return normalizeFilesystemPath(filePath, params.repoRoot);
  }

  try {
    const parsed = new URL(value);
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.startsWith("/@fs/")) {
      return normalizeFilesystemPath(pathname.slice("/@fs".length), params.repoRoot);
    }
    if (pathname.startsWith("/src/")) {
      return path.posix.join("apps/desktop", pathname.slice(1));
    }
    if (pathname.startsWith("/packages/")) {
      return pathname.slice(1);
    }
    if (pathname.startsWith("/")) {
      return `${parsed.origin}${pathname}`;
    }
  } catch {
    return value;
  }

  return value;
}

function decodeFileUrl(value: string): string {
  return decodeURIComponent(value.replace("file://", ""));
}

function normalizeFilesystemPath(filePath: string, repoRoot: string): string {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const normalizedFilePath = path.resolve(filePath);
  const relativePath = path.relative(normalizedRepoRoot, normalizedFilePath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join(path.posix.sep);
  }

  return normalizedFilePath.split(path.sep).join(path.posix.sep);
}

async function readOptionalCpuProfile(filePath: string): Promise<CpuProfile | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as CpuProfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}
