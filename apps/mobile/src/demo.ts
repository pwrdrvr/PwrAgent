import type { MobileThread } from "../../../packages/shared/src/mobile-gateway";
/** Invented showcase data. This mode never connects or dispatches. */
const seeds = [
  { target: { instanceId: "demo-studio", backend: "codex", threadId: "demo-orbit" }, machineLabel: "Studio Mac", row: { id: "demo-orbit", title: "Ship the orbital dashboard", updatedAt: 3, projectKey: "Orbit", threadStatus: "active" } },
  { target: { instanceId: "demo-mini", backend: "codex", threadId: "demo-garden" }, machineLabel: "Lab Mini", row: { id: "demo-garden", title: "Review the garden sensor data", updatedAt: 2, projectKey: "Garden", threadStatus: "idle" } },
  { target: { instanceId: "demo-linux", backend: "codex", threadId: "demo-aurora" }, machineLabel: "Linux Lab", row: { id: "demo-aurora", title: "Prepare Aurora for the weekend", updatedAt: 1, projectKey: "Aurora", threadStatus: "idle" } },
] as const;
export const demoThreads: MobileThread[] = seeds.map((seed) => ({
  ...seed, row: { ...seed.row, ref: { backend: "codex", threadId: seed.target.threadId }, rowRevision: "demo", source: "codex", titleSource: "explicit", inbox: { inInbox: true }, linkedDirectories: [], ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "ready" },
}));
