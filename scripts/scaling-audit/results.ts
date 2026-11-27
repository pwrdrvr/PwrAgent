import { appendFileSync } from "node:fs";

export function record(row: object) {
  appendFileSync(process.env.AUDIT_RESULTS!, JSON.stringify(row) + "\n");
}
