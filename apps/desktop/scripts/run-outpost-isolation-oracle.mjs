import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = await mkdtemp(path.join(os.tmpdir(), "outpost-oracle-build-"));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
  const bundle = path.join(directory, "probe.cjs");
  await build({
    entryPoints: [path.join(root, "apps/desktop/scripts/probe-outpost-isolation.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["electron"],
    loader: { ".md": "text" }, define: { "import.meta.url": JSON.stringify("file:///opt/probe.cjs") },
  });
  if (process.argv.includes("--docker")) {
    const dockerfile = await readFile(path.join(root, "packages/pwragent/Dockerfile"), "utf8");
    const version = /^ARG CODEX_VERSION=([\d.]+)$/m.exec(dockerfile)?.[1];
    if (!version) throw new Error("Missing pinned Outpost Codex version");
    await writeFile(path.join(directory, "Dockerfile"), `FROM node:24-bookworm
RUN npm install --prefix /opt/codex --no-fund @openai/codex@${version}
COPY probe.cjs /opt/probe.cjs
RUN mkdir -p /run/codex-auth && printf '%s' '{"OPENAI_API_KEY":"oracle-canary"}' > /run/codex-auth/auth.json
USER 501:20
ENTRYPOINT ["node", "/opt/probe.cjs", "/opt/codex/node_modules/.bin/codex", "/run/codex-auth/auth.json"]
`);
    const tag = `pwragent-isolation-oracle:${process.pid}`;
    run("docker", ["build", "-q", "-t", tag, directory]);
    try {
      const seccompIndex = process.argv.indexOf("--seccomp");
      const seccomp = seccompIndex === -1 ? "unconfined" : process.argv[seccompIndex + 1];
      if (!seccomp) throw new Error("--seccomp requires a profile path");
      run("docker", ["run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`, tag]);
    } finally { run("docker", ["image", "rm", tag]); }
  } else {
    run(process.execPath, [bundle, process.argv[2] ?? "codex"]);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
