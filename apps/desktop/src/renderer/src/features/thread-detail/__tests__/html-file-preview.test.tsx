import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HtmlPreviewNavigationEvent } from "../../../../../shared/html-preview";
import { HtmlFilePreview } from "../HtmlFilePreview";
import { HTML_PREVIEW_LOCAL_LINK_ORIGIN } from "../html-preview-document";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function previewApi() {
  let navigate: ((event: HtmlPreviewNavigationEvent) => void) | undefined;
  return {
    api: {
      readHtmlPreviewAssets: vi.fn(async ({ refs }: { refs: string[] }) => ({
        assets: refs.filter((ref) => ref === "logo.png").map((ref) => ({ ref, dataUrl: PNG_URL })),
        skipped: [],
      })),
      onHtmlPreviewNavigation: vi.fn((callback: (event: HtmlPreviewNavigationEvent) => void) => {
        navigate = callback;
        return () => {
          navigate = undefined;
        };
      }),
    },
    navigate: (url: string) => act(() => navigate?.({ url })),
  };
}

async function frame(): Promise<HTMLIFrameElement> {
  return await screen.findByTitle("HTML preview: Brief") as HTMLIFrameElement;
}

describe("HtmlFilePreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the page without scripts, with local images inlined and web loads counted", async () => {
    const { api } = previewApi();
    render(
      <HtmlFilePreview
        content={'<img src="logo.png"><img src="https://example.com/pixel.gif"><script>1</script>'}
        desktopApi={api}
        label="Brief"
        path="/work/brief/index.html"
        runScriptsByDefault={false}
      />,
    );

    const element = await frame();
    expect(element.getAttribute("sandbox")).toBe("");
    expect(element.getAttribute("name")).toBe("pwragent-html-preview");
    expect(element.getAttribute("srcdoc")).toContain(PNG_URL);
    expect(element.getAttribute("srcdoc")).not.toContain("example.com");
    expect(api.readHtmlPreviewAssets).toHaveBeenCalledWith({
      path: "/work/brief/index.html",
      refs: ["logo.png"],
    });
    expect(screen.getByText("Scripts off")).toBeInTheDocument();
    expect(screen.getByText("No network access")).toBeInTheDocument();
    expect(screen.getByText("Blocked 1 web resource")).toBeInTheDocument();
  });

  it("runs scripts only in a frame that still has no other permission", async () => {
    const { api } = previewApi();
    render(
      <HtmlFilePreview
        content="<p>Hi</p>"
        desktopApi={api}
        label="Brief"
        path="/work/brief/index.html"
        runScriptsByDefault={false}
      />,
    );

    await frame();
    fireEvent.click(screen.getByRole("button", { name: "Run Scripts" }));

    const scripted = await frame();
    expect(scripted.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByRole("button", { name: "Stop Scripts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Scripts on")).toBeInTheDocument();
  });

  it("starts with scripts on when the operator's setting says so", async () => {
    const { api } = previewApi();
    render(
      <HtmlFilePreview
        content="<p>Hi</p>"
        desktopApi={api}
        label="Brief"
        path="/work/brief/index.html"
        runScriptsByDefault
      />,
    );

    expect((await frame()).getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("asks before opening a link the page tried to follow", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { api, navigate } = previewApi();
    render(
      <HtmlFilePreview
        content="<p>Hi</p>"
        desktopApi={api}
        label="Brief"
        path="/work/brief/index.html"
        runScriptsByDefault={false}
      />,
    );
    await frame();

    navigate("https://example.com/docs");
    expect(screen.getByText("Open this link in your browser?")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/docs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    expect(screen.queryByText("Open this link in your browser?")).not.toBeInTheDocument();
  });

  it("opens a linked preview file in the viewer, and offers nothing for other schemes", async () => {
    const onOpenLocalFile = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { api, navigate } = previewApi();
    render(
      <HtmlFilePreview
        content="<p>Hi</p>"
        desktopApi={api}
        label="Brief"
        path="/work/brief/index.html"
        runScriptsByDefault={false}
        onOpenLocalFile={onOpenLocalFile}
      />,
    );
    await frame();

    const link = new URL(HTML_PREVIEW_LOCAL_LINK_ORIGIN);
    link.searchParams.set("path", "/work/brief/appendix.html");
    navigate(link.href);
    expect(screen.getByText("Open appendix.html here?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenLocalFile).toHaveBeenCalledWith("/work/brief/appendix.html");

    // A script file is not something the viewer shows, and http off this
    // machine is not something the app opens.
    link.searchParams.set("path", "/work/brief/run.command");
    navigate(link.href);
    expect(screen.getByText("This link cannot be opened from a preview.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    navigate("http://example.com/");
    expect(screen.getByText("This link cannot be opened from a preview.")).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not ask for a peer page's files", async () => {
    const { api } = previewApi();
    render(
      <HtmlFilePreview
        content={'<img src="logo.png">'}
        desktopApi={api}
        federationTarget={{ scope: "remote", instanceId: "peer" }}
        label="Brief"
        path="/work/brief/index.html"
        runScriptsByDefault={false}
      />,
    );

    await frame();
    await waitFor(() => {
      expect(screen.getByText("Files beside a page on another machine are not loaded.")).toBeInTheDocument();
    });
    expect(api.readHtmlPreviewAssets).not.toHaveBeenCalled();
  });
});
