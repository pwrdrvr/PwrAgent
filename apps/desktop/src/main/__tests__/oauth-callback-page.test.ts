// @vitest-environment jsdom
// The page the browser lands on after PwrSnap's or PwrGit's authorization
// screen. It is served from a throwaway localhost port by an app the person is
// not looking at, so the page itself has to say what opened it — and it is the
// one PwrAgent surface with no window chrome, no renderer, and no E2E lane.
//
// Parsed rather than string-matched: this project is `environment: "node"`, so
// the file opts into jsdom for `DOMParser` alone. Nothing here executes the
// page's inline script — jsdom will not run it from `parseFromString` — so the
// few assertions that must reach inside it read the source text, and say so.
//
// The icon geometry the page depends on lives with the assets it measures, in
// `scripts/pwrsuite-brand-icons.test.mjs`.
import { describe, expect, it } from "vitest";
import { htmlResponse } from "../mcp-connections/local-mcp-connection-service";

/**
 * Both sister apps, each with its own copy. Parameterized because the page is
 * one template with a brand substituted in: fixtures that named PwrGit while
 * rendering PwrSnap let `displayName` collapse to a constant unnoticed, and
 * made "the PwrSnap page never mentions PwrGit" unassertable.
 */
const CONNECTIONS = [
  { id: "pwrgit", name: "PwrGit", other: "PwrSnap" },
  { id: "pwrsnap", name: "PwrSnap", other: "PwrGit" },
] as const;

/** The two states the callback server renders: the live poll, and a refusal. */
function connecting({ name }: (typeof CONNECTIONS)[number]) {
  return [`Connecting PwrAgent to ${name}`, `${name} approved the request.`, { liveStatus: true }] as const;
}
function declined({ name }: (typeof CONNECTIONS)[number]) {
  return [`${name} connection declined`, "The user declined.", {}] as const;
}

function render(
  connection: (typeof CONNECTIONS)[number],
  [title, detail, options]: readonly [string, string, { liveStatus?: boolean }],
) {
  return htmlResponse(title, detail, options, connection.id);
}

function parse(page: string): Document {
  return new DOMParser().parseFromString(page, "text/html");
}

/** The two marks the diagram draws, in document order. */
function marks(page: string): HTMLImageElement[] {
  return [...parse(page).querySelectorAll("img")];
}

describe("OAuth callback page", () => {
  it("names the app that opened the window in every state", () => {
    // Not the heading: it names PwrAgent only while the connection is going
    // well. "Connection could not be completed" on an unfamiliar localhost tab
    // is exactly where someone needs to be told whose window this is.
    for (const connection of CONNECTIONS) {
      for (const state of [connecting(connection), declined(connection)]) {
        expect(parse(render(connection, state)).body.textContent)
          .toContain("PwrAgent opened this window");
      }
    }
  });

  it("brands each page as its own sister app and never the other", () => {
    for (const connection of CONNECTIONS) {
      const page = render(connection, connecting(connection));
      const document_ = parse(page);
      expect(document_.title).toContain(connection.name);
      // `:not(.app-icon)` skips the tile, whose only child is the mark.
      expect([...document_.querySelectorAll(".app > span:not(.app-icon)")]
        .map((span) => span.textContent))
        .toEqual(["PwrAgent", connection.name]);
      // Whole page, not just the body: comments ship to the browser too, and
      // the CSS here is commented at length about how the marks are sized —
      // prose that names the other app is one edit away at any time.
      expect(page).not.toContain(connection.other);
    }
  });

  it("flies PwrAgent's mark in the tab, not the sister app's", () => {
    // The favicon answers "what is this?" before any of the page does, and the
    // window belongs to PwrAgent. Served from the route the diagram already
    // uses, which `img-src 'self'` in the page's CSP allows.
    for (const connection of CONNECTIONS) {
      const icon = parse(render(connection, connecting(connection)))
        .querySelector('link[rel="icon"]');
      expect(icon?.getAttribute("href")).toBe("/assets/pwragent.png");
      expect(icon?.getAttribute("type")).toBe("image/png");
    }
  });

  it("draws both marks the same way, because both assets are full-bleed", () => {
    // Every PwrSuite asset fills its own canvas, so the page needs no per-mark
    // correction and neither mark may carry one. A class here that scaled one
    // of them would be compensating for a padded asset — the fix for that is
    // to re-source the asset, not to patch this page. The assets themselves
    // are measured in scripts/pwrsuite-brand-icons.test.mjs.
    for (const connection of CONNECTIONS) {
      const [pwragent, sister] = marks(render(connection, connecting(connection)));
      expect(sister?.getAttribute("src")).toBe(`/assets/${connection.id}.png`);
      expect(pwragent?.getAttribute("src")).toBe("/assets/pwragent.png");
      expect([pwragent?.className, sister?.className]).toEqual(["app-mark", "app-mark"]);
    }
  });

  it("frames each mark in a tile that is its parent, not itself", () => {
    // `.app-mark` fills its tile with `width: 100%`, which resolves against
    // the tile's content box — so the tile has to be the parent. Merged onto
    // one element, that 100% would resolve against the grid area instead, and
    // the tile's padding, border, and backing plate would apply to the
    // artwork rather than frame it.
    for (const mark of marks(render(CONNECTIONS[0], connecting(CONNECTIONS[0])))) {
      expect(mark.classList.contains("app-icon")).toBe(false);
      expect(mark.parentElement?.classList.contains("app-icon")).toBe(true);
    }
  });

  it("leaves the marks out of the accessible name, which the labels carry", () => {
    // `alt=""` present, not merely non-empty-alt absent: an <img> with no alt
    // at all is announced as its src filename, which is worse than the name
    // this deliberately drops. Each mark sits beside a visible <span> naming
    // the same app, so alt text would have a screen reader say it twice.
    for (const connection of CONNECTIONS) {
      const page = render(connection, connecting(connection));
      expect(marks(page).map((mark) => mark.getAttribute("alt"))).toEqual(["", ""]);
      // aria-label is ignored on a bare div, so the diagram needs a real role
      // for the relationship it draws to reach assistive technology at all.
      const diagram = parse(page).querySelector(".connection");
      expect(diagram?.getAttribute("role")).toBe("group");
      expect(diagram?.getAttribute("aria-label"))
        .toBe(`PwrAgent connection to ${connection.name}`);
    }
  });

  it("escapes what the authorization server sent before echoing it", () => {
    // The payload goes in `detail`: that is the argument built from
    // `error_description` off the callback URL. `title` is a fixed literal at
    // every call site, so a test that only injected there would stay green
    // with the real sink unescaped — and this page's CSP allows inline script.
    const payload = '<script>alert("t")</script>';
    for (const connection of CONNECTIONS) {
      for (const page of [
        htmlResponse(`${connection.name} connection declined`, payload, {}, connection.id),
        htmlResponse(payload, "The user declined.", {}, connection.id),
      ]) {
        expect(parse(page).querySelectorAll("script")).toHaveLength(0);
        expect(page).toContain("&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;");
      }
    }
    // The escaped text still reads back as the original, in both slots.
    const rendered = parse(htmlResponse(payload, payload, {}, "pwrgit"));
    expect(rendered.getElementById("title")?.textContent).toBe(payload);
    expect(rendered.getElementById("detail")?.textContent).toBe(payload);
  });

  it("keeps the live poll's updates on textContent, and its arguments in order", () => {
    // Read from the source: jsdom does not execute the page's script, and
    // these are the properties that stop wire data becoming DOM XSS. The PR
    // that added `settle` collapsed three separate assignments into one, so a
    // single careless edit here now moves all three sinks at once.
    const page = render(CONNECTIONS[0], connecting(CONNECTIONS[0]));
    expect(page).toContain("const settle = (state, heading, detail, status) => {");
    expect(page).toContain('document.getElementById("detail").textContent = detail;');
    expect(page).toContain('document.getElementById("status").textContent = status;');
    expect(page).toContain('document.getElementById("title").textContent = heading;');
    expect(page).not.toContain("innerHTML");
    // The tab moves with the heading: a backgrounded window shows nothing
    // else, and left alone it kept saying "Connecting…" after the connection
    // was up or had failed.
    expect(page).toContain("document.title = heading;");
    expect(page).toContain('settle("is-connected", "PwrAgent is connected to PwrGit"');
    expect(page).toContain('settle("is-failed", "Connection could not be completed"');
    expect(page).toContain("void check();");
  });

  it("gives up on a callback port that has stopped answering", () => {
    // PwrAgent closes the port 30s after it finishes; without a cap the page
    // polls a dead loopback address at 4Hz for as long as the tab is open.
    const page = render(CONNECTIONS[0], connecting(CONNECTIONS[0]));
    expect(page).toContain("if (++unanswered > 240) {");
    expect(page).toContain("unanswered = 0;");
    // The refusal page has no poll at all, so it carries no script to cap.
    expect(render(CONNECTIONS[0], declined(CONNECTIONS[0]))).not.toContain("<script>");
  });
});
