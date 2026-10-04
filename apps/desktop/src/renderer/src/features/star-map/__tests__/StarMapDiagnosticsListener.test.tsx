import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AppMetadata } from "../../../../../shared/app-metadata";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapDiagnosticsListener } from "../StarMapDiagnosticsListener";

const metadata: AppMetadata = {
  applicationName: "PwrAgent",
  applicationVersion: "1.2.3",
  buildIdentity: { kind: "packaged" },
  copyright: "Copyright © 2026 PwrDrvr LLC.",
  homepage: "https://pwragent.ai",
  documentationUrl: "https://docs.pwragent.ai",
  electronVersion: "41.2.1",
  chromeVersion: "142.0.0.0",
  nodeVersion: "24.0.0",
  mainProcessId: 4100,
  rendererProcessId: 4101,
  activeProfileName: "personal",
  logFilePath: "/logs/pwragent.log",
  codexProfilePath: "/profiles/codex",
};

it("copies the active remote intake target from the Star Map window", async () => {
  let copyDiagnostics: (() => void) | undefined;
  const copyRichText = vi.fn(async () => undefined);
  const desktopApi: DesktopApi = {
    copyRichText,
    readAppMetadata: vi.fn(async () => metadata),
    onCopyLocalDiagnosticsInfoRequested: vi.fn((listener) => {
      copyDiagnostics = listener;
      return () => {
        copyDiagnostics = undefined;
      };
    }),
  };

  render(
    <StarMapDiagnosticsListener
      desktopApi={desktopApi}
      intakeTarget={{
        instanceId: "peer-2018",
        label: "Harold-MBP-2018",
        federationTarget: { scope: "remote", instanceId: "peer-2018" },
      }}
    />,
  );

  act(() => copyDiagnostics?.());

  await waitFor(() => {
    expect(copyRichText).toHaveBeenCalledWith({
      text: expect.stringContaining([
        "Surface: Federation Star Map",
        "PwrAgent version: 1.2.3",
        "PwrAgent build: Packaged",
        "Thread creation state: Intake open; no thread created yet",
        "Target instance ID: peer-2018",
        "Target instance label: Harold-MBP-2018",
        "Federation routing target: remote:peer-2018",
      ].join("\n")),
      html: expect.stringContaining("<pre><code>Collected at (UTC):"),
    });
  });
});
