import path from "node:path";
import { resolveActiveProfilePath } from "../profile";

/** Legacy shared image paths remain readable while history is promoted to thread ownership. */
export function imageInputFileRoot(): string {
  return resolveActiveProfilePath(path.join("state", "image-inputs"));
}
