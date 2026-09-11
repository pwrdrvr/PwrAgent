// The page the browser lands on after PwrSnap's or PwrGit's authorization
// screen. It is served from a throwaway localhost port by an app the person is
// not looking at, so the page itself has to say what opened it — and it is the
// one PwrAgent surface with no window chrome, no renderer, and no E2E lane.
//
// The icon geometry it depends on lives with the assets it measures, in
// `scripts/pwrsuite-brand-icons.test.mjs`.
import { describe, expect, it } from "vitest";
import { htmlResponse } from "../mcp-connections/local-mcp-connection-service";

/** The three states the callback server can render, for either sister app. */
const CONNECTING = ["Connecting PwrAgent to PwrGit", "PwrGit approved the request.", { liveStatus: true }] as const;
const DECLINED = ["PwrGit connection declined", "The user declined.", {}] as const;

function render(
  [title, detail, options]: readonly [string, string, { liveStatus?: boolean }],
  connectionId: "pwrgit" | "pwrsnap" = "pwrgit",
) {
  return htmlResponse(title, detail, options, connectionId);
}

describe("OAuth callback page", () => {
  it("names the app that opened the window in every state", () => {
    // Not the heading: it names PwrAgent only while the connection is going
    // well. "Connection could not be completed" on an unfamiliar localhost tab
    // is exactly where someone needs to be told whose window this is.
    for (const state of [CONNECTING, DECLINED]) {
      for (const connectionId of ["pwrgit", "pwrsnap"] as const) {
        expect(render(state, connectionId))
          .toContain("PwrAgent opened this window");
      }
    }
  });

  it("flies PwrAgent's mark in the tab, not the sister app's", () => {
    // The favicon answers "what is this?" before any of the page does, and the
    // window belongs to PwrAgent. Served from the route the card already uses,
    // which `img-src 'self'` in the page's CSP allows.
    for (const connectionId of ["pwrgit", "pwrsnap"] as const) {
      expect(render(CONNECTING, connectionId))
        .toContain('<link rel="icon" type="image/png" href="/assets/pwragent.png">');
    }
  });

  it("moves the tab title with the heading once the connection settles", () => {
    // A backgrounded tab shows nothing but its title, and this page polls for
    // minutes: left alone the tab still read "Connecting…" after the
    // connection was up, or after it had failed.
    const page = render(CONNECTING);
    expect(page).toContain("<title>Connecting PwrAgent to PwrGit</title>");
    // One helper sets the heading, the tab and the status together, so the
    // three cannot drift apart the way the title already had.
    expect(page).toContain("document.title = heading;");
    expect(page).toContain('settle("is-connected", "PwrAgent is connected to PwrGit"');
    expect(page).toContain('settle("is-failed", "Connection could not be completed"');
  });

  it("scales only the sister app whose mark carries a margin", () => {
    // Asserted on the tags, not on the page: the rule itself is in the
    // stylesheet on every render, and only the markup decides who wears it.
    expect(render(CONNECTING, "pwrgit"))
      .toContain('<img class="app-mark app-mark--inset-plate" src="/assets/pwrgit.png"');
    expect(render(CONNECTING, "pwrsnap"))
      .toContain('<img class="app-mark" src="/assets/pwrsnap.png"');
    // PwrAgent's own mark is full-bleed, so it never wears the modifier.
    expect(render(CONNECTING, "pwrgit"))
      .toContain('<img class="app-mark" src="/assets/pwragent.png"');
  });

  it("frames each mark in a tile the scale cannot grow", () => {
    // The compensation is a transform, and a transform on the framed element
    // would scale its border and backing plate with the artwork — PwrGit's
    // tile would come out a quarter larger than PwrAgent's. The frame has to
    // be the parent for the artwork alone to move.
    const page = render(CONNECTING, "pwrgit");
    expect(page).toContain('<span class="app-icon"><img class="app-mark');
    expect(page).not.toMatch(/<img[^>]*class="[^"]*\bapp-icon\b/u);
  });

  it("leaves the marks out of the accessible name, which the labels carry", () => {
    // Each mark sits beside a visible <span> naming the same app, so alt text
    // would have a screen reader announce "PwrGit PwrGit".
    const page = render(CONNECTING, "pwrgit");
    expect(page).not.toMatch(/<img[^>]*alt="(?!")/u);
    expect(page).toContain("<span>PwrGit</span>");
    expect(page).toContain("<span>PwrAgent</span>");
  });

  it("escapes what the authorization server sent before echoing it", () => {
    const page = htmlResponse(
      '<script>alert("t")</script>',
      "error_description from the wire",
      {},
      "pwrgit",
    );
    expect(page).not.toContain('<script>alert("t")</script>');
    expect(page).toContain("&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;");
  });
});
