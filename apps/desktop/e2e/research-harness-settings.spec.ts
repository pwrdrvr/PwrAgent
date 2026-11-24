import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { WebSocketServer } from "ws";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { enableResearchFixture, seedResearchState } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
// Contrived values only: no real host, team, project or key.
const TEAM = "o-12345678-1234-4123-8123-123456789abc";
const ENVIRONMENT = "avm-87654321-4321-4321-8321-cba987654321";
const PLATFORM_KEY = "nuc_ak_contrived0000000000000000000000000000000000";
const SWARM = "contrived-swarm";
const SHOTS = path.resolve(specDir, "../../../.local");

/** Attached to the report, and kept under the checkout's ignored .local/ for PR media. */
async function capture(window: Page, testInfo: { attach: (name: string, options: { body: Buffer; contentType: string }) => Promise<void> }, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const body = await window.screenshot({ path: path.join(SHOTS, `research-harness-settings-${name}.png`) });
  await testInfo.attach(name, { body, contentType: "image/png" });
}

async function openNewHarnessRun(window: Page) {
  await window.getByRole("tab", { name: "Research", exact: true }).click();
  const panel = window.getByRole("region", { name: "Research", exact: true });
  const harness = panel.getByRole("button", { name: "Open Math Harness", exact: true });
  const newRun = panel.getByRole("button", { name: "New run", exact: true });
  // Returning from Settings, the panel may still have its New run form open.
  await expect(harness.or(newRun).first()).toBeVisible();
  if (!(await harness.isVisible())) await newRun.click();
  await harness.click();
  return panel;
}

/** A source swarm as the pinned record contract describes it: two members, three findings, ended. */
function sourceRecords(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [
    { event: "started", swarm: SWARM, project: "contrived-project", session: "default", task: "Contrived objective", dir: `.ultramath/${SWARM}`,
      members: ["m1", "m2"], model: "example-model", member_steps: 10, budget: 30, deadline_at_ms: 1_800_000 },
    ...[1, 2, 3].map((i) => ({ event: "finding", swarm: SWARM, member: i % 2 ? "m1" : "m2", direction: `d${i}`, finding: `f${i}`, label: "note",
      text: `Contrived platform finding ${i}`, paths: [] })),
    { event: "ended", swarm: SWARM, outcome: "solved", calls: 3, reserved_calls: 3, checks: 0 },
  ];
  return records.map((record, i) => ({ ...record, seq: i + 1, at_ms: 1_000 + i }));
}

type Observed = { opens: Array<Record<string, unknown>>; authorizations: string[]; urls: string[]; firstLines: string[]; ops: string[] };

/**
 * A loopback MathOS Platform speaking the shapes the platform's web client
 * uses: the web app's runtime pin, `orgs`, `open` with a ticket, and the
 * runtime socket with the `agent-vm-runtime-v1` subprotocol.
 */
async function startFakePlatform(): Promise<{ origin: string; observed: Observed; close: () => Promise<void> }> {
  const observed: Observed = { opens: [], authorizations: [], urls: [], firstLines: [], ops: [] };
  const records = sourceRecords();
  const server = http.createServer((request, response) => {
    observed.urls.push(request.url ?? "");
    const send = (status: number, body: unknown, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/") { send(200, `<script type="module" src="/app/assets/index-Fake1.js"></script>`, "text/html"); return; }
    if (request.method === "GET" && request.url === "/app/assets/index-Fake1.js") { send(200, "const pin={web:!0,runtime:`0.61.0`,ipc:6};", "text/javascript"); return; }
    let text = "";
    request.on("data", (chunk) => { text += String(chunk); });
    request.on("end", () => {
      observed.authorizations.push(request.headers.authorization ?? "");
      if (request.headers.authorization !== `Bearer ${PLATFORM_KEY}`) { send(401, { error: "invalid credential" }); return; }
      const body = JSON.parse(text || "{}") as Record<string, unknown>;
      if (request.url === "/v1/orgs") { send(200, { orgs: [{ id: TEAM, name: "Contrived team", kind: "private", role: "owner" }] }); return; }
      if (request.url === "/v1/open") {
        observed.opens.push(body);
        send(200, { state: "ready", environment: ENVIRONMENT, version: body.version, ipc_version: body.ipc_version,
          bundle_sha256: "0".repeat(64), programs_root: `/opt/nucleus/runtimes/${"0".repeat(64)}/bin`, ticket: `ticket-${observed.opens.length}` });
        return;
      }
      send(404, { error: "not found" });
    });
  });
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("agent-vm-runtime-v1") ? "agent-vm-runtime-v1" : false) });
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith(`/v1/runtime/${ENVIRONMENT}?ticket=`)) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      let buffer = "";
      let signedIn = false;
      ws.on("message", (data) => {
        buffer += String(data);
        for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
          const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          buffer = buffer.slice(newline + 1);
          if (!signedIn) { observed.firstLines.push(JSON.stringify(frame)); signedIn = frame.nucleus_key === PLATFORM_KEY; continue; }
          observed.ops.push(String(frame.op));
          const reply = (value: unknown) => ws.send(Buffer.from(`${JSON.stringify(value)}\n`), { binary: true });
          if (frame.op === "whoami") reply({ id: frame.id, ok: { process: 3, handles: [{ endpoint: "swarm", actions: ["records", "status", "stop"] }] } });
          else if (frame.op === "swarm.records") {
            const after = typeof frame.after === "number" ? frame.after : 0;
            reply({ id: frame.id, ok: { swarm: frame.swarm, records: records.filter((record) => (record.seq as number) > after) } });
          } else reply({ id: frame.id, error: { code: "invalid_input", message: `unknown variant \`${String(frame.op)}\`` } });
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    observed,
    close: async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** The research replay fixture, with its thread linked to a directory so evidence has a workspace. */
function fixtureWithWorkspace(root: string): string {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const fixture = JSON.parse(fs.readFileSync(path.join(specDir, "fixtures/research/replay.fixture.json"), "utf8")) as { steps: Array<{ method?: string; result?: unknown }> };
  for (const step of fixture.steps) {
    if (step.method !== "thread/list" || !Array.isArray(step.result)) continue;
    for (const thread of step.result as Array<Record<string, unknown>>) {
      if (thread.title === "Queue ordering research") thread.linkedDirectories = [{ id: "harness-workspace", label: "Harness workspace", path: workspace, kind: "local" }];
    }
  }
  const fixturePath = path.join(root, "research-mathos.fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  return fixturePath;
}

test("MathOS Platform settings sign in, find the team, and import a swarm from the New run form", async ({ playwright: _playwright }, testInfo) => {
  const platform = await startFakePlatform();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mathos-e2e-"));
  const app = await launchElectronApp({
    fixturePath: fixtureWithWorkspace(root),
    secretStorage: "memory",
    preLaunchHook: async (homeRoot) => {
      enableResearchFixture(homeRoot);
      seedResearchState(stateDbPathForHomeRoot(homeRoot));
      // The platform's address is the loopback fake; Settings would show it under Platform address.
      applyDesktopSettingsPatch(configTomlPathForHomeRoot(homeRoot), { research: { mathos: { origin: platform.origin } } });
    },
  });
  try {
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    let panel = await openNewHarnessRun(app.window);
    await expect(panel.getByText(/Import swarm records straight from the MathOS Platform/)).toBeVisible();
    await capture(app.window, testInfo, "source-unconfigured");

    // The form links to the one place the source is configured.
    await panel.getByRole("button", { name: "Open Harness settings", exact: true }).click();
    const section = app.window.getByRole("region", { name: "Open Math Harness", exact: true });
    await expect(section.getByRole("radio", { name: "MathOS Platform", exact: true })).toHaveAttribute("aria-checked", "true");
    const key = section.getByLabel("MathOS Platform API key", { exact: true });
    await key.fill(PLATFORM_KEY);
    await key.press("Enter");
    await expect(section.getByRole("button", { name: "Remove saved MathOS Platform API key", exact: true })).toBeVisible();
    await section.getByRole("button", { name: "Find teams", exact: true }).click();
    await expect(section.getByRole("combobox", { name: "Team", exact: true })).toContainText("Contrived team");
    await section.getByRole("button", { name: "Save", exact: true }).click();
    await expect(section.getByText("MathOS Platform", { exact: true }).first()).toBeVisible();
    await section.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(section.getByText("MathOS Platform · responding", { exact: true })).toBeVisible();
    await expect(section.getByLabel("Source supports")).toContainText("Import supported");
    await expect(section).not.toContainText(PLATFORM_KEY);

    // Measured with the first row uncovered: the sticky section header can sit over it after scrolling.
    await section.getByRole("radio", { name: "MathOS Platform", exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
    const { violations } = await new AxeBuilder({ page: app.window }).setLegacyMode(true)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).include("section:has(#settings-section-experimental-open-math-harness-heading)").analyze();
    expect(violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await capture(app.window, testInfo, "settings-saved");

    // config.toml holds the source and the team, never the key.
    const config = fs.readFileSync(configTomlPathForHomeRoot(app.homeRoot), "utf8");
    expect(config).toContain("harness_source = \"mathos\"");
    expect(config).toContain(`team = "${TEAM}"`);
    expect(config).not.toContain(PLATFORM_KEY);

    const nav = app.window.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    panel = await openNewHarnessRun(app.window);
    const source = panel.getByRole("region", { name: "Source", exact: true });
    await expect(source).toContainText(`MathOS Platform at ${platform.origin.replace("http://", "")}`);
    await expect(source).toContainText(TEAM);
    await expect(source).toContainText("Stored in PwrAgent");
    await source.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(source).toContainText("responding");
    await expect(panel.getByText("The MathOS Platform does not offer running a swarm to PwrAgent.")).toBeVisible();
    await expect(panel.getByText("This team’s VM does not offer discovery reads to PwrAgent.")).toBeVisible();
    await capture(app.window, testInfo, "source-configured");

    await panel.getByLabel("Project", { exact: true }).fill("contrived-project");
    await panel.getByLabel("Session", { exact: true }).fill("default");
    await panel.getByLabel("Swarm", { exact: true }).fill(SWARM);
    await panel.getByRole("button", { name: "Import records", exact: true }).click();
    await panel.getByRole("tab", { name: "Findings", exact: true }).click();
    await expect(panel.getByText("Contrived platform finding 3")).toBeVisible();
    await capture(app.window, testInfo, "imported");

    // The key reached the platform only as the Bearer header and the runtime's first line, and only reads were sent.
    expect(platform.observed.opens.every((body) => body.wake === false && body.ticket === true && body.team === TEAM && body.version === "0.61.0")).toBe(true);
    expect(platform.observed.authorizations.every((value) => value === `Bearer ${PLATFORM_KEY}`)).toBe(true);
    expect(platform.observed.urls.some((url) => url.includes(PLATFORM_KEY))).toBe(false);
    expect(platform.observed.firstLines.every((line) => line === JSON.stringify({ nucleus_key: PLATFORM_KEY }))).toBe(true);
    expect(new Set(platform.observed.ops)).toEqual(new Set(["whoami", "swarm.records"]));
  } finally {
    await app.close();
    await platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
