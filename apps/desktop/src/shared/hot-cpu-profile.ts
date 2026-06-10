export type HotCpuProfileCapturedEvent = {
  capturedAt: string;
  profileFilename: string;
  profilePath: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
};

export function buildHotCpuProfileHandoffMessage(
  event: HotCpuProfileCapturedEvent,
): string {
  return [
    "PwrAgent captured a renderer CPU profile.",
    `Session basename: ${event.sessionDirectoryName}`,
    `Session directory path: ${event.sessionDirectory}`,
    `CPU profile basename: ${event.profileFilename}`,
    `CPU profile path: ${event.profilePath}`,
    "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots.",
  ].join("\n");
}
