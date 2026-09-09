import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Only explicit, bounded local validation arms probes. Normal Internet traffic
// cannot allocate records, fetch observations, or discover the response secret.
export class CloudflareOriginProbes {
  private probes = new Map<string, { proof: string; seen: boolean; expires: number }>();

  arm() {
    for (const [id, probe] of this.probes) {
      if (probe.expires < Date.now()) this.probes.delete(id);
    }
    if (this.probes.size >= 16) throw new Error("An endpoint validation is already running.");
    const id = randomBytes(32).toString("hex");
    const entry = { proof: randomBytes(32).toString("hex"), seen: false, expires: Date.now() + 60_000 };
    this.probes.set(id, entry);
    return { id, proof: entry.proof, observed: () => entry.seen, close: () => this.probes.delete(id) };
  }

  observe(request: IncomingMessage): string | undefined {
    const id = request.headers["x-pwragent-security-probe"];
    if (typeof id !== "string") return undefined;
    const probe = this.probes.get(id);
    if (!probe || probe.expires < Date.now()) return undefined;
    probe.seen = true;
    return probe.proof;
  }
}
