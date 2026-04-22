import fs from "node:fs";
import { fileURLToPath } from "node:url";

const REVIEW_PROMPT_URL = new URL("./review-prompt.md", import.meta.url);

export function readReviewPrompt(): string {
  return fs.readFileSync(fileURLToPath(REVIEW_PROMPT_URL), "utf8");
}
