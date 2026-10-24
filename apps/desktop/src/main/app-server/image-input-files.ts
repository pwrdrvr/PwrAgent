import path from "node:path";
import { resolveActiveProfilePath } from "../profile";

/** Legacy shared image paths remain readable until their 30-day expiry. */
export function imageInputFileRoot(): string {
  return resolveActiveProfilePath(path.join("state", "image-inputs"));
}
