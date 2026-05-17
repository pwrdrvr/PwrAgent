import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppLicenseDocumentKind } from "../../../../../shared/app-metadata";
import type { DesktopApi } from "../../../lib/desktop-api";
import { LicenseDocumentWindow } from "../LicenseDocumentWindow";

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("LicenseDocumentWindow", () => {
  it("loads bundled third-party notices", async () => {
    const readLicenseDocument = vi.fn(async (kind: AppLicenseDocumentKind) => ({
      kind,
      title: "Third-Party Notices",
      content: "PwrAgent Third-Party Notices\n\nreact@19.2.5",
    }));
    (window as Window & { pwragent?: DesktopApi }).pwragent = {
      readLicenseDocument,
    };

    render(<LicenseDocumentWindow />);

    await waitFor(() => {
      expect(readLicenseDocument).toHaveBeenCalledWith("third-party-licenses");
    });
    expect(await screen.findByText(/react@19\.2\.5/)).toBeInTheDocument();
  });
});
