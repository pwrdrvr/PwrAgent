import { getDesktopApi, type DesktopApi } from "./desktop-api";

export async function copyText(
  text: string,
  desktopApiOverride?: Pick<DesktopApi, "copyText">,
): Promise<void> {
  const desktopApi = desktopApiOverride ?? getDesktopApi();
  if (desktopApi?.copyText) {
    try {
      await desktopApi.copyText(text);
      return;
    } catch {
      // Fall through to browser-side copy paths.
    }
  }

  const clipboardApi =
    typeof navigator !== "undefined" &&
    "clipboard" in navigator &&
    typeof navigator.clipboard?.writeText === "function"
      ? navigator.clipboard
      : undefined;

  if (clipboardApi) {
    await clipboardApi.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand?.("copy");
  document.body.removeChild(textarea);
}

export function formatCopyTooltip(path: string, maxLength = 72): string {
  return `${elideMiddle(path, maxLength)}\nClick to copy to clipboard`;
}

function elideMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const visible = Math.max(8, maxLength - 1);
  const left = Math.ceil(visible / 2);
  const right = Math.floor(visible / 2);
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}
