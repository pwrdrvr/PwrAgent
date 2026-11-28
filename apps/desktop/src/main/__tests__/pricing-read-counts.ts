import { vi } from "vitest";
import type { StateDb } from "../state/state-db";

// Wrap prepared statements once so repeated executions of a cached statement
// count the materialized records too. EXPLAIN plans and query timings are separate.
export function countPricingRows(db: StateDb) {
  const counts = { usageRows: 0, cardRows: 0, metadataRows: 0, metadataKeys: 0, payloadQueries: 0 };
  const prepare = db.raw.prepare.bind(db.raw);
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (/SELECT/i.test(sql) && /thread_usage_lines|thread_sub_agents|token_miser_objects/.test(sql)) {
      for (const method of ["all", "get"] as const) {
        const read = statement[method].bind(statement);
        Object.assign(statement, { [method]: (...args: unknown[]) => {
          if (/\bpayload\s+FROM\s+token_miser_objects/i.test(sql)) counts.payloadQueries++;
          const result = read(...args);
          for (const row of Array.isArray(result) ? result : [result]) {
            if (!row || typeof row !== "object") continue;
            // Both replay recovery plans enumerate stored keys. The older page also
            // fetched the full payload; count that independently below.
            if (("objectId" in row || "object_id" in row) && /token_miser_objects/.test(sql)) counts.metadataKeys++;
            if ("usage_line_id" in row) counts.usageRows++;
            if ("card" in row) counts.cardRows++;
            if ("payload" in row && /token_miser_objects/.test(sql)) counts.metadataRows++;
          }
          return result;
        } });
      }
    }
    return statement;
  });
  return counts;
}
