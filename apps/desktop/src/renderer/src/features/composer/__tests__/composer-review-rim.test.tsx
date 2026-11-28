import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { cssWithOnlyProperties } from "../../../styles/__tests__/css-property-cascade";
import { Composer } from "../Composer";

// The rule: the review panel stands in for the input inside `.composer__box`,
// so exactly one rim is painted between the panel and the transcript. A rim on
// the panel itself drew a second, inset edge, and the legend pulled that
// border down half a line, leaving the box's rim as a stray outline above it.
const RIM_PROPERTIES = [
  "display",
  "border",
  "border-top",
  "border-width",
  "border-top-width",
  "border-style",
  "border-top-style",
];

/**
 * app.css cut to the rim's cascade, with every `var()` replaced by its value.
 * jsdom drops a `border` shorthand that reads a custom property, which would
 * leave the composer box looking rimless.
 */
function rimCss(): string {
  const css = cssWithOnlyProperties(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../styles/app.css"), "utf8"),
    RIM_PROPERTIES,
  );
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    if (!tokens.has(match[1]!)) tokens.set(match[1]!, match[2]!.trim());
  }
  let resolved = css;
  for (let pass = 0; pass < 8 && resolved.includes("var("); pass += 1) {
    resolved = resolved.replace(
      /var\((--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
      (whole, name: string, fallback?: string) => tokens.get(name) ?? fallback?.trim() ?? whole,
    );
  }
  return resolved;
}

function backendSummary(): BackendSummary {
  return {
    kind: "codex",
    label: "OpenAI",
    available: true,
    methods: ["thread/start", "turn/start"],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: false,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: true,
      transcriptPagination: true,
      toolUse: false,
      approvalRequests: true,
      multiDirectoryThreads: true,
    },
    executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
    launchpadOptions: {
      models: [{ id: "gpt-5.4", label: "GPT-5.4", supportsReasoning: true }],
      reasoningEfforts: ["low", "medium", "high"],
    },
  };
}

const thread: NavigationThreadSummary = {
  id: "thread-review",
  title: "Review thread",
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  linkedDirectories: [{ id: "project", kind: "local", label: "Demo", path: "/repo/demo" }],
  inbox: { inInbox: false },
};

beforeAll(() => {
  const emptyRect = { bottom: 0, height: 0, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0, x: 0, y: 0 } as DOMRect;
  const textPrototype = Text.prototype as Text & {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  textPrototype.getClientRects ??= () => [];
  textPrototype.getBoundingClientRect ??= () => emptyRect;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
});

afterEach(() => {
  cleanup();
  document.head.replaceChildren();
});

function installRimCss() {
  const style = document.createElement("style");
  style.textContent = rimCss();
  document.head.append(style);
}

function paintsTopRim(element: Element): boolean {
  const style = getComputedStyle(element);
  // A `display: contents` element draws no box, so its border never paints.
  return style.display !== "contents"
    && style.borderTopStyle !== "none"
    && style.borderTopStyle !== "hidden"
    && Number.parseFloat(style.borderTopWidth) > 0;
}

/** Every element from the panel up to and including the composer box that paints a top rim. */
function rimsAroundPanel(): string[] {
  const panel = screen.getByRole("group", { name: "Review target" });
  const box = panel.closest(".composer__box");
  expect(box).not.toBeNull();
  const rims: string[] = [];
  for (let element: Element | null = panel; element; element = element.parentElement) {
    if (paintsTopRim(element)) rims.push(element.className);
    if (element === box) break;
  }
  return rims;
}

describe("composer review panel rim", () => {
  it("draws one rim around a review panel opened from the composer", async () => {
    installRimCss();
    render(<Composer backends={[backendSummary()]} disabled={false} skills={[]} thread={thread} />);
    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, { target: { value: "/review" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(rimsAroundPanel()).toEqual(["composer__box"]);
  });

  it("puts a to-do card's accent edge on that one rim", async () => {
    installRimCss();
    render(
      <Composer
        backends={[backendSummary()]}
        disabled={false}
        skills={[]}
        thread={thread}
        reviewRequest={{
          id: 1,
          threadId: thread.id,
          backend: "codex",
          todo: { id: "todo-review", allowOpenItems: true },
          todoTitle: "Review the open pull request",
        }}
      />,
    );
    await screen.findByRole("group", { name: "Review target" });

    const rims = rimsAroundPanel();
    expect(rims).toHaveLength(1);
    expect(rims[0]).toContain("composer__box--review-from-todo");
  });
});
