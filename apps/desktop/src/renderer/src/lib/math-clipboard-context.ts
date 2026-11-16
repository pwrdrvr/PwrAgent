import { createContext } from "react";
import type { DesktopApi } from "./desktop-api";

// Only the context is eager. Formula controls and export code stay in the
// demand-loaded math runtime and the click-loaded export chunk respectively.
export const MathClipboardApiContext = createContext<
  Pick<DesktopApi, "copyText" | "copyRichText"> | undefined
>(undefined);
