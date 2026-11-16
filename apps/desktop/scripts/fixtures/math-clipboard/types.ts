export {};

declare global {
  interface Window {
    formulaClipboard: { text?: string; html?: string; png?: string };
  }
}
