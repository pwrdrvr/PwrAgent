import { vi } from "vitest";

export type OwnerStartupRecord = { name: string; order: number };

/** Read actual calls from the host harness, retaining global invocation order. */
export function recordOwnerCalls(getter: unknown, prefix: string, names: RegExp): OwnerStartupRecord[] {
  if (!vi.isMockFunction(getter)) throw new Error("The recording requires a mocked owner getter.");
  const seen = new Set<unknown>();
  const records: OwnerStartupRecord[] = [];
  for (const result of getter.mock.results) {
    if (result.type !== "return" || !result.value) continue;
    for (const [name, method] of Object.entries(result.value)) {
      if (!names.test(name) || !vi.isMockFunction(method) || seen.has(method)) continue;
      seen.add(method);
      for (const [index, order] of method.mock.invocationCallOrder.entries()) {
        let label = `${prefix}.${name}`;
        if (prefix === "registry" && name === "onEvent") {
          const listener = method.mock.calls[index]?.[0];
          const source = typeof listener === "function" ? listener.toString() : "";
          label = source.includes("interruptStartupStorageMaintenance") ? "maintenance.subscribe"
            : source.includes("handleAgentEventForWorkingState") ? "working.subscribe"
            : "renderer.subscribe";
        }
        records.push({ name: label, order });
      }
    }
  }
  return records;
}

export function recordCall(name: string, method: unknown): OwnerStartupRecord[] {
  if (!vi.isMockFunction(method)) throw new Error(`The recording requires a mock for ${name}.`);
  return method.mock.invocationCallOrder.map((order) => ({ name, order }));
}

/** No work source may observe an owner whose tool/peer bindings are incomplete. */
export function assertOwnerHooksBeforeWork(events: string[], handlers: string[], workSources: string[]): void {
  for (const work of workSources) {
    const started = events.indexOf(work);
    if (started < 0) throw new Error(`Missing work source: ${work}`);
    for (const handler of handlers) {
      const installed = events.indexOf(handler);
      if (installed < 0 || installed > started) throw new Error(`${work} started before ${handler} was installed.`);
    }
  }
}
