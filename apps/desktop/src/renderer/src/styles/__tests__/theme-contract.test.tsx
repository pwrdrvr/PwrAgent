import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(testDir, "../app.css");
const css = readFileSync(cssPath, "utf8");

function extractRootTokens(source: string): Record<string, string> {
  return extractTokensForSelector(source, ":root");
}

function extractTokensForSelector(
  source: string,
  selector: string,
): Record<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootMatch = source.match(
    new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!rootMatch?.groups?.body) {
    throw new Error(`Expected app.css to define a ${selector} token block`);
  }

  return Object.fromEntries(
    [...rootMatch.groups.body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()]
    )
  );
}

/**
 * Pulls the body out of the FIRST top-level CSS rule whose selector
 * matches exactly.
 *
 * "Top-level" means the rule's selector is anchored at the start of a
 * line — every base rule in `app.css` lives at column 0. Attribute-
 * scoped overrides like `:root[data-density="compact"] .thread-row { … }`
 * still mention the selector text but are NOT preceded by a newline +
 * the bare selector, so they're skipped here. The intent of these tests
 * is to lock the *base* rule shape, not every override.
 *
 * Caveat: if `app.css` ever wraps a selector in a `@media` (or
 * `@supports`) block at the top level, this picks the outermost
 * `{ … \n}` it sees, which may not be the rule the test intended. Scope
 * by the surrounding at-rule boundary if/when that happens.
 */
function extractRuleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = source.match(
    new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!ruleMatch?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }

  return ruleMatch.groups.body;
}

/** First `z-index` in a rule body, NaN when the rule declares none. */
function readZIndex(rule: string): number {
  return Number(rule.match(/z-index:\s*(\d+);/)?.[1] ?? Number.NaN);
}

function expandHex(hex: string): string {
  const normalized = hex.replace("#", "");
  if (normalized.length === 3) {
    return [...normalized].map((char) => `${char}${char}`).join("");
  }
  return normalized;
}

function relativeLuminance(hex: string): number {
  const normalized = expandHex(hex);
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(normalized.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);

  return (lighter + 0.05) / (darker + 0.05);
}

describe("Tangerine Terminal theme contract", () => {
  const tokens = extractRootTokens(css);
  const lightTokens = extractTokensForSelector(css, ':root[data-theme="light"]');

  it("defines the semantic tokens used by the renderer theme", () => {
    expect(tokens).toMatchObject({
      "accent": "#ff8a1f",
      "accent-border": "color-mix(in srgb, var(--accent) 42%, transparent)",
      "accent-bright": "#ffb35c",
      "accent-soft": "color-mix(in srgb, var(--accent) 12%, transparent)",
      "bg-app": "#000000",
      "bg-input": "#080808",
      "bg-panel": "#0a0a0a",
      "bg-panel-elevated": "#101010",
      "bg-panel-hover": "#14110d",
      "bg-row-active": "#120800",
      "bg-sidebar": "#050505",
      "border-strong": "rgba(247, 243, 235, 0.2)",
      "border-subtle": "rgba(247, 243, 235, 0.1)",
      "danger-soft": "rgba(185, 66, 50, 0.24)",
      "danger-text": "#ffb0a1",
      "focus-ring": "var(--accent)",
      "info-text": "#9fc8ff",
      "success-soft": "rgba(74, 148, 92, 0.18)",
      "success-text": "#9ce5b3",
      "terminal-ansi-black": "#000000",
      "terminal-ansi-blue": "#2472c8",
      "terminal-ansi-bright-black": "#666666",
      "terminal-ansi-bright-blue": "#3b8eea",
      "terminal-ansi-bright-cyan": "#29b8db",
      "terminal-ansi-bright-green": "#23d18b",
      "terminal-ansi-bright-magenta": "#d670d6",
      "terminal-ansi-bright-red": "#f14c4c",
      "terminal-ansi-bright-white": "#e5e5e5",
      "terminal-ansi-bright-yellow": "#f5f543",
      "terminal-ansi-cyan": "#11a8cd",
      "terminal-ansi-green": "#0dbc79",
      "terminal-ansi-magenta": "#bc3fbc",
      "terminal-ansi-red": "#cd3131",
      "terminal-ansi-white": "#e5e5e5",
      "terminal-ansi-yellow": "#e5e510",
      "terminal-bg": "#000000",
      "terminal-cursor": "#ffb35c",
      "terminal-cursor-accent": "#160a00",
      "terminal-fg": "#cccccc",
      "terminal-scrollbar-thumb":
        "color-mix(in srgb, var(--terminal-fg) 34%, transparent)",
      "text-muted": "#8c857a",
      "text-primary": "#f7f3eb",
      "text-secondary": "#b8b0a5",
    });
  });

  it("keeps core text and accent pairings above contrast thresholds", () => {
    const pairs: Array<[string, string, number]> = [
      ["text-primary", "bg-app", 4.5],
      ["text-primary", "bg-panel", 4.5],
      ["text-secondary", "bg-app", 4.5],
      ["text-secondary", "bg-panel-elevated", 4.5],
      ["text-muted", "bg-app", 4.5],
      ["text-muted", "bg-panel-elevated", 4.5],
      ["accent", "bg-app", 4.5],
      ["accent", "bg-panel-elevated", 4.5],
      ["button-text", "accent", 4.5],
      ["terminal-fg", "terminal-bg", 4.5],
    ];

    for (const [foreground, background, threshold] of pairs) {
      expect(
        contrastRatio(tokens[foreground], tokens[background]),
        `${foreground} on ${background}`
      ).toBeGreaterThanOrEqual(threshold);
    }
  });

  it("keeps light terminal ANSI white readable on a light canvas", () => {
    expect(lightTokens).toMatchObject({
      "terminal-bg": "#ffffff",
      "terminal-fg": "#333333",
      "terminal-ansi-white": "#555555",
      "terminal-ansi-bright-white": "#a5a5a5",
    });
    expect(contrastRatio(lightTokens["terminal-fg"], lightTokens["terminal-bg"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(lightTokens["terminal-ansi-white"], lightTokens["terminal-bg"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves finished env-action rows flat so the quiet base stays reachable", () => {
    // Every run carries exactly one of three status modifiers, so while all
    // three painted at-rest chrome the transparent base and its :hover rule
    // could never match — a stack of finished actions still rendered as a
    // stack of cards, which is the complaint the flat base exists to answer.
    // Only a live run and a failure earn chrome without being pointed at.
    const painted = ["running", "failed", "exited"].filter((status) =>
      new RegExp(
        `\\.composer__queued--env-action\\.composer__queued--env-action-${status}\\s*\\{[^}]*(background|border-color)`,
      ).test(css),
    );

    expect(painted).toEqual(["running", "failed"]);
  });

  it("keeps compact row actions at the WCAG 2.2 target-size floor", () => {
    // 2.5.8 AA is 24x24. Padding alone left these around 22px.
    expect(extractRuleBody(css, ".live-strip__item-action")).toMatch(
      /min-height:\s*24px;/,
    );

    // Same floor for the thread-row hover cluster: the transcript-gaps
    // pass first shrank these to 22px for visual weight and the review
    // raised them back — 24px is as small as these standalone targets
    // may go. The shared rule carries the height for pin + kebab; the
    // add-reaction chip matches via its cluster override.
    expect(
      extractRuleBody(css, ".thread-row__pin-button,\n.thread-row__overflow-button"),
    ).toMatch(/height:\s*24px;/);
    expect(
      extractRuleBody(css, ".thread-row__actions .thread-row__chip--add-reaction"),
    ).toMatch(/height:\s*24px;[\s\S]*min-width:\s*24px;/);

    // The in-title unpin control is a real 24x24 target too (axe's
    // target-size rule gives no inline exception to flex-item buttons);
    // its negative margins collapse the layout footprint back to the
    // 18px line slot, so the heading's geometry doesn't move.
    expect(extractRuleBody(css, ".thread-row__heading-pin")).toMatch(
      /width:\s*24px;[\s\S]*height:\s*24px;/,
    );

    // A 24px target is worthless while something paints over it — the
    // pinned-row hover reserve keeps the revealed cluster off the
    // in-title unpin pin. Pinned (all four reveal arms + the value + the
    // cluster-side literals it is derived from) so a cluster resize or a
    // dropped keyboard arm revisits the derivation in the rule's comment
    // in the same commit.
    expect(
      extractRuleBody(
        css,
        ".thread-row-shell:hover .thread-row--pinned .thread-row__heading,\n"
          + ".thread-row-shell:has(.thread-row__overflow-button:focus-visible) .thread-row--pinned .thread-row__heading,\n"
          + ".thread-row-shell:has(.thread-row__chip--add-reaction:focus-visible) .thread-row--pinned .thread-row__heading,\n"
          + ".thread-row-shell:has(.thread-row__chip--add-reaction.is-open) .thread-row--pinned .thread-row__heading",
      ),
    ).toMatch(/padding-right:\s*46px;/);
    expect(extractRuleBody(css, ".thread-row__actions")).toMatch(
      /right:\s*11px;[\s\S]*gap:\s*4px;/,
    );
    // The cluster's 11px offset and the reserve inequality's first term
    // both derive from the card's inline padding (10px + 1px border), so
    // that literal belongs in the same pin set: shrink the card padding
    // and 11/46 stay green while the kebab drifts off the content edge
    // and the pin loses its clearance.
    expect(extractRuleBody(css, ".thread-row")).toMatch(
      /padding:\s*4px 10px;/,
    );
    // Not extractRuleBody: the bare selector would match the shared
    // pin+kebab chrome rule first; this anchors the standalone width
    // rule's own body.
    expect(css).toMatch(/(?:^|\n)\.thread-row__overflow-button \{[^}]*width:\s*26px;/);

    // And the open-thread overlay keeps the explicit floor the old
    // in-flow button carried: at the XS title notch a chipless card
    // computes to 23.75px, so covering the card alone is not enough.
    expect(extractRuleBody(css, ".thread-row__open")).toMatch(
      /min-height:\s*24px;/,
    );

    // The directory summary button is a 2.5.8 target too. The third
    // density pass took its block padding to 2px (content ~20px), so
    // this min-height is the ONLY thing holding the button — and the
    // selected-directory highlight box that shares its chrome — at the
    // floor. Padding is free to move; this is not.
    expect(extractRuleBody(css, ".directory-row__summary")).toMatch(
      /min-height:\s*24px;/,
    );
  });

  it("keeps every border chevron on one size", () => {
    // The band above the composer stacks two disclosure rows whose chevrons
    // sit directly above one another. `.composer__queued-env-action-chevron`
    // was 10px while everything else was 8px, and the mismatch was invisible
    // until the sub-agents strip put the two side by side.
    //
    // `.directory-row__chevron` is deliberately excluded: it lives in the
    // sidebar at a different type scale, not in this band.
    const chevrons = [
      ".live-work-rail__chevron",
      ".live-strip__chevron",
      ".transcript-activity__chevron",
      ".transcript-work-phase-group__chevron",
      ".composer__queued-env-action-chevron",
    ];

    const sizes = chevrons.map((selector) => {
      const body = extractRuleBody(css, selector);
      return {
        selector,
        width: body.match(/\bwidth:\s*([^;]+);/)?.[1]?.trim(),
        height: body.match(/\bheight:\s*([^;]+);/)?.[1]?.trim(),
      };
    });

    for (const size of sizes) {
      expect(size, `${size.selector} geometry`).toMatchObject({
        width: "8px",
        height: "8px",
      });
    }
  });

  it("keeps the band above the composer on one uppercase-label idiom", () => {
    // `.composer__queued-label` shipped without the 0.04em tracking its two
    // neighbours use, so the same 11px/700 caps label rendered two ways
    // depending on which row drew it.
    for (const selector of [
      ".live-work-rail__title",
      ".live-strip__label",
      ".composer__queued-label",
    ]) {
      const body = extractRuleBody(css, selector);
      expect(body, `${selector} label idiom`).toMatch(/font-size:\s*11px;/);
      expect(body, `${selector} label idiom`).toMatch(/font-weight:\s*700;/);
      expect(body, `${selector} label idiom`).toMatch(
        /letter-spacing:\s*0\.04em;/,
      );
      expect(body, `${selector} label idiom`).toMatch(
        /text-transform:\s*uppercase;/,
      );
    }
  });

  it("does not leave unresolved theme token references in app.css", () => {
    const localTokens = new Set([
      "thinking-scanner-beam-width",
      "thinking-scanner-travel",
      // Scanner tint indirection — defined on `.thinking-scanner`, not
      // `:root`. Every value they resolve to IS a theme token; the locals
      // exist so a variant (the Attention tab's remote-turn readout) can
      // retarget the colour without restating the beam gradient.
      "thinking-scanner-tint",
      "thinking-scanner-tint-bright",
      "thinking-scanner-track",
      // Sidebar rail/lane inset system — defined on `.sidebar`, not `:root`.
      "sidebar-rail-inset",
      "sidebar-lane-inset",
      "sidebar-masthead-pull",
      // Live run strip row height — defined on `.live-strip`, not `:root`.
      // The four-row scroll cap is derived from it, so the two cannot drift.
      "live-strip-row-h",
      // Automations table sticky stack — defined on `.automations-table`, not
      // `:root`. Column-header height, and the measured row height its run
      // lines offset themselves by; both are layout, not theme.
      "automations-header-h",
      "automation-row-h",
      // Star Map sky parallax offset — registered with `@property` as a
      // non-inherited length and written per gesture frame by the screen.
      // Geometry, not theme.
      "star-map-sky-x",
      "star-map-sky-y",
    ]);
    const tokenReferences = [...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map(
      ([, token]) => token
    );
    const missingTokens = tokenReferences.filter(
      (token) => !tokens[token] && !localTokens.has(token)
    );

    expect([...new Set(missingTokens)]).toEqual([]);
  });

  it("removes the previous chartreuse accent literals from app.css", () => {
    expect(css).not.toContain("#b8ff4d");
    expect(css).not.toContain("184, 255, 77");
    expect(css).not.toContain("168, 255, 63");
  });

  it("keeps transcript bottom reserve close to the thinking indicator height", () => {
    // The items rule may declare bottom padding either explicitly
    // (`padding-bottom: 10px`) or via the `padding` shorthand
    // (`padding: T R 10px L`). Both are equivalent; the lock here is
    // that the bottom value stays at 10 (transcript-gaps pass: the old
    // 24 stacked with the composer's border-top + 12px pad into a
    // ~37px blank band under the last entry) and that the pending
    // override still drops to 4px while the thinking line is last.
    //
    // The override keys off `.transcript-list__pending-item`, the
    // role="listitem" wrapper the thinking line now renders inside (a
    // bare role="status" child of the role="list" scroller trips
    // aria-required-children). The pending element is always the last
    // child of that wrapper, so the pre-wrapper
    // `.transcript-list__pending:last-child` form would fire even when a
    // questionnaire / approval card follows it.
    const itemsRule = css.match(/\.transcript-list__items\s*\{[\s\S]*?\}/)?.[0];
    expect(itemsRule).toBeDefined();
    expect(itemsRule).toMatch(
      /padding-bottom:\s*10px;|padding:\s*\S+\s+\S+\s+10px(?:\s+\S+)?;/,
    );
    expect(css).toMatch(
      /\.transcript-list__items:has\(\.transcript-list__pending-item:last-child\)\s*\{[\s\S]*?padding-bottom:\s*4px;[\s\S]*?\}/
    );
    // Negative regex stays — guard against accidental large bottom
    // values (>= 40px) regardless of which form is used.
    expect(itemsRule).not.toMatch(
      /padding-bottom:\s*(?:[4-9]\d|\d{3,})px;|padding:\s*\S+\s+\S+\s+(?:[4-9]\d|\d{3,})px(?:\s+\S+)?;/,
    );
  });

  it("keeps messaging origin actors visible when breadcrumbs are truncated", () => {
    const actorRules = [
      ...css.matchAll(
        /(?:^|\n)\.transcript-message__messaging-actor\s*\{(?<body>[\s\S]*?)\n\}/g,
      ),
    ];

    expect(actorRules).toHaveLength(1);
    expect(actorRules[0]?.groups?.body).toContain("flex: 0 0 auto;");
  });

  it("keeps loading draggable without masking clicks behind the empty state", () => {
    const emptyStateRule = extractRuleBody(css, ".thread-empty-state");
    const pendingMainRule = extractRuleBody(css, ".app-main--thread-detail-pending");

    expect(emptyStateRule).toContain("padding: 0 16px;");
    expect(emptyStateRule).toContain("flex: 1;");
    expect(emptyStateRule).toContain("min-height: 0;");
    expect(emptyStateRule).not.toContain("-webkit-app-region: drag;");
    expect(pendingMainRule).toContain("-webkit-app-region: drag;");
    expect(css).not.toMatch(
      /\.thread-empty-state \*\s*\{[\s\S]*?-webkit-app-region:\s*drag;[\s\S]*?\}/
    );
  });

  it("keeps thread migration project headers sticky inside the project list", () => {
    const projectHeaderRule = extractRuleBody(
      css,
      ".settings-thread-management__project-head",
    );

    expect(projectHeaderRule).toContain("position: sticky;");
    expect(projectHeaderRule).toContain("top: 0;");
    expect(projectHeaderRule).toContain("z-index: 3;");
    expect(projectHeaderRule).toContain("background: var(--bg-panel-elevated);");
  });

  it("keeps onboarding and warning overlays clickable without losing window drag affordances", () => {
    const overlayRule = extractRuleBody(css, ".onboarding-wizard-overlay");
    const titlebarRule = extractRuleBody(css, ".onboarding-wizard__titlebar");
    const warningBannerRule = extractRuleBody(css, ".codex-config-warning-banner");

    expect(overlayRule).toContain("-webkit-app-region: no-drag;");
    expect(css).toMatch(
      /\.onboarding-wizard-overlay__scrim\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?\}/
    );
    expect(titlebarRule).toContain("-webkit-app-region: drag;");
    expect(css).toMatch(
      /\.onboarding-wizard__titlebar button,\s*\.onboarding-wizard__titlebar input,\s*\.onboarding-wizard__titlebar a,\s*\.onboarding-wizard__titlebar select,\s*\.onboarding-wizard__titlebar \[role="button"\]\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?\}/
    );
    expect(warningBannerRule).toContain("-webkit-app-region: no-drag;");
  });

  it("keeps warning notices distinct from dark app surfaces", () => {
    const warningNoticeRule = extractRuleBody(
      css,
      '.app-notice-toast[data-tone="warning"]',
    );
    const successNoticeRule = extractRuleBody(
      css,
      '.app-notice-toast[data-tone="success"]',
    );
    const errorNoticeRule = extractRuleBody(
      css,
      '.app-notice-toast[data-tone="error"]',
    );

    expect(warningNoticeRule).toContain(
      "border-color: color-mix(in srgb, var(--status-warning) 52%, var(--border-subtle));",
    );
    expect(warningNoticeRule).toContain(
      "background: color-mix(in srgb, var(--bg-panel-elevated) 92%, var(--status-warning) 8%);",
    );
    expect(css).toMatch(
      /\.app-notice-toast\[data-tone="warning"\] \.app-notice-toast__eyebrow\s*\{[\s\S]*?color:\s*var\(--status-warning\);[\s\S]*?\}/,
    );
    expect(successNoticeRule).toContain("var(--status-ok)");
    expect(errorNoticeRule).toContain("var(--status-error)");
    expect(css).toMatch(
      /\.app-notice-toast\[data-tone="success"\] \.app-notice-toast__eyebrow\s*\{[\s\S]*?color:\s*var\(--status-ok\);[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /\.app-notice-toast\[data-tone="error"\] \.app-notice-toast__eyebrow\s*\{[\s\S]*?color:\s*var\(--status-error\);[\s\S]*?\}/,
    );
  });

  it("keeps custom toast actions from collapsing the message column", () => {
    const customActionsRule = extractRuleBody(
      css,
      ".app-notice-toast__custom-actions",
    );

    expect(customActionsRule).toContain("grid-column: 1 / -1;");
    expect(customActionsRule).toContain("justify-content: flex-end;");
  });

  it("lets transcript scroll restoration own scroll anchoring", () => {
    expect(css).toMatch(
      /\.transcript-list__items\s*\{[\s\S]*?overflow-anchor:\s*none;[\s\S]*?\}/
    );
  });

  it("keeps thread header titles tall enough for descenders", () => {
    const compactTitleRule = extractRuleBody(css, ".thread-header__compact-title");
    const threadRowTitleRule = extractRuleBody(css, ".thread-row__title");

    expect(css).toMatch(
      /\.thread-header__title,\s*\.thread-empty-state h2\s*\{[\s\S]*?line-height:\s*1\.16;[\s\S]*?\}/
    );
    expect(compactTitleRule).toContain("padding-bottom: 2px;");
    expect(compactTitleRule).toContain("line-height: 1.25;");
    expect(threadRowTitleRule).toContain("padding-bottom: 2px;");
    expect(threadRowTitleRule).toContain("line-height: 1.25;");
    expect(css).not.toMatch(
      /\.thread-header--launchpad \.thread-header__title\s*\{[\s\S]*?line-height:\s*1\.05;[\s\S]*?\}/
    );
    expect(compactTitleRule).not.toContain("line-height: 1;");
  });

  it("keeps Settings select values tall enough for descenders", () => {
    const settingsSelectRule = extractRuleBody(css, ".settings-select");

    expect(settingsSelectRule).toContain("line-height: 1.2;");
    expect(settingsSelectRule).not.toContain("line-height: 1;");
  });

  it("uses composer-style compact chips for provider defaults", () => {
    const providerSelectRule = extractRuleBody(css, ".settings-select--chip");
    const composerSelectRule = extractRuleBody(css, ".composer-dropdown__button");

    expect(providerSelectRule).toContain("height: 26px;");
    expect(providerSelectRule).toContain("border-radius: 999px;");
    expect(providerSelectRule).toContain("background-color: var(--bg-input);");
    expect(providerSelectRule).toContain("font-size: 13px;");
    expect(providerSelectRule).toContain("font-weight: 500;");
    expect(composerSelectRule).toContain("min-height: 26px;");
    expect(composerSelectRule).toContain("border-radius: 999px;");
    expect(composerSelectRule).toContain("background: var(--bg-input);");
    expect(composerSelectRule).toContain("font-size: 13px;");
    expect(composerSelectRule).toContain("font-weight: 500;");
  });

  it("keeps messaging indicators ahead of thread header title overflow", () => {
    const headerMainRule = extractRuleBody(css, ".thread-header__main");
    const statusBarRule = extractRuleBody(css, ".messaging-status-bar");
    const eyebrowRowRule = extractRuleBody(css, ".thread-header__eyebrow-row");
    const compactTitleRule = extractRuleBody(css, ".thread-header__compact-title");

    expect(headerMainRule).toContain("flex: 1 1 0;");
    expect(statusBarRule).toContain("flex: 0 0 auto;");
    expect(statusBarRule).toContain("min-width: max-content;");
    expect(eyebrowRowRule).toContain("min-width: 0;");
    expect(compactTitleRule).toContain("flex: 0 1 auto;");
    expect(compactTitleRule).toContain("overflow: hidden;");
    expect(css).toMatch(
      /\.thread-header__eyebrow-row > \.thread-row__chip\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?\}/
    );
  });

  it("keeps the entire Messaging control interactive in Settings title bars", () => {
    const titlebarDragRuleIndex = css.indexOf(".settings-titlebar * {");
    const messagingNoDragRuleIndex = css.indexOf(
      ".settings-titlebar .messaging-status-bar,",
    );

    expect(titlebarDragRuleIndex).toBeGreaterThan(-1);
    expect(messagingNoDragRuleIndex).toBeGreaterThan(titlebarDragRuleIndex);
    expect(css).toMatch(
      /\.settings-titlebar \.messaging-status-bar,\s*\.settings-titlebar \.messaging-status-bar \*\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?\}/,
    );
  });

  it("layers Messaging popovers and tooltips above full-window settings", () => {
    const appTitlebarRule = extractRuleBody(css, ".app-titlebar");
    const settingsLayerRule = extractRuleBody(css, ".app-shell__settings-layer");
    const messagingTooltipRule = extractRuleBody(
      css,
      ".messaging-status-tooltip",
    );

    expect(settingsLayerRule).toContain("z-index: 120;");
    expect(appTitlebarRule).toContain("z-index: 130;");
    expect(messagingTooltipRule).toContain("z-index: 140;");
  });

  it("keeps every Windows title-bar control and hover bridge interactive", () => {
    const appTitlebarRuleIndex = css.indexOf(".app-titlebar {");
    const titlebarControlsRuleIndex = css.indexOf(
      ".app-titlebar__left,\n.app-titlebar__left *,",
    );

    expect(appTitlebarRuleIndex).toBeGreaterThan(-1);
    expect(titlebarControlsRuleIndex).toBeGreaterThan(appTitlebarRuleIndex);
    expect(css).toMatch(
      /\.app-titlebar__left,\s*\.app-titlebar__left \*,\s*\.app-titlebar__right,\s*\.app-titlebar__right \*\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?\}/,
    );
  });

  it("keeps the thread title reveal hit target to the rendered title text", () => {
    const compactTitleRule = extractRuleBody(css, ".thread-header__compact-title");
    const titleButtonRule = extractRuleBody(css, ".thread-header__title-button");

    expect(compactTitleRule).toContain("width: fit-content;");
    expect(compactTitleRule).toContain("max-width: min(58vw, 520px);");
    expect(titleButtonRule).toContain("display: inline-block;");
    expect(titleButtonRule).toContain("max-width: 100%;");
    expect(titleButtonRule).not.toMatch(/(?:^|\n)\s*width:\s*100%;/);
  });

  it("keeps launchpad setup output from shrinking the header summary", () => {
    const setupComposerRule = extractRuleBody(
      css,
      ".thread-view__launchpad-composer:has(.transcript-panel--setup)"
    );

    expect(setupComposerRule).toContain("flex: 1 1 0;");
    expect(setupComposerRule).toContain("min-height: 0;");
  });

  it("keeps environment setup status, copying, and path wrapping on theme tokens", () => {
    const setupRule = extractRuleBody(css, ".launchpad-pending--setup");
    const successRule = extractRuleBody(
      css,
      ".launchpad-pending__status--success"
    );
    const copyButtonRule = extractRuleBody(
      css,
      ".transcript-copy-button.transcript-copy-button--setup"
    );

    expect(setupRule).toContain("container-type: inline-size;");
    expect(successRule).toContain("border-color: var(--success-border);");
    expect(successRule).toContain("background: var(--success-soft);");
    expect(successRule).toContain("color: var(--success-text);");
    expect(copyButtonRule).toContain("opacity: 1;");
    expect(css).toMatch(
      /@container \(max-width: 1000px\)\s*\{[\s\S]*?\.launchpad-pending__meta-path\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/
    );
  });

  it("keeps launchpad composer errors selectable and directly copyable", () => {
    const errorRule = extractRuleBody(css, ".composer__meta--copyable");
    const errorTextRule = extractRuleBody(css, ".composer__meta-text");
    const copyButtonRule = extractRuleBody(
      css,
      ".transcript-copy-button--composer-error"
    );

    expect(errorRule).toContain("user-select: text;");
    expect(errorTextRule).toContain("user-select: text;");
    expect(copyButtonRule).toContain("opacity: 1;");
  });

  it("keeps pricing usage cards selectable and directly copyable", () => {
    const pricingRowRule = extractRuleBody(css, ".pricing-usage-row");
    const pricingRunningTotalRule = extractRuleBody(css, ".pricing-running-total");

    expect(pricingRowRule).toContain("user-select: text;");
    expect(pricingRunningTotalRule).toContain("user-select: text;");
  });

  it("keeps transcript link chips atomic during selection", () => {
    const prChipRule = extractRuleBody(css, ".pr-chip");
    const transcriptPrChipRule = extractRuleBody(css, ".thread-markdown .pr-chip");
    const skillChipRule = extractRuleBody(css, ".skill-chip--transcript");
    const threadChipRule = extractRuleBody(css, ".thread-chip");

    expect(prChipRule).toContain("-webkit-user-select: none;");
    expect(prChipRule).toContain("user-select: none;");
    expect(transcriptPrChipRule).toContain("-webkit-user-select: all;");
    expect(transcriptPrChipRule).toContain("user-select: all;");
    expect(skillChipRule).toContain("-webkit-user-select: none;");
    expect(skillChipRule).toContain("user-select: none;");
    expect(threadChipRule).toContain("-webkit-user-select: none;");
    expect(threadChipRule).toContain("user-select: none;");
  });

  it("anchors the context rail below the header and reserves one shared width for the chat", () => {
    // The rail is anchored to `.thread-view__layout` (absolute), NOT the
    // window, so it starts below the thread header. The header therefore owns
    // its full width — it must NOT carry a rail-width gutter (the old
    // `position: fixed; top: 0` rail overlapped the header and forced the
    // toggles/MSG to squash, then slide under the rail).
    expect(extractRuleBody(css, ".context-rail")).toContain(
      "position: absolute;"
    );
    // A media query must NOT flip the rail back to `position: static` (the
    // old "stack the rail below the chat" narrow-width design) — anchored
    // absolute, an in-flow full-width rail collapses the chat to zero width.
    expect(css).not.toMatch(
      /@media[^{]*\{[\s\S]*?\.context-rail[^{]*\{[^}]*position:\s*static/
    );
    expect(css).not.toMatch(
      /\.thread-header[^{]*\{[^}]*padding-right:\s*calc\(var\(--context-rail-effective/
    );
    // Single source of truth for the chat-side gutter: `--context-rail-effective`
    // is computed once on `.thread-view`, sidebar-aware (not a bare `vw`) so a
    // wide rail can't starve the chat on a narrow window. The panel renders at
    // it and the chat column reserves it (+ the 48px spine) — same value, so
    // the panel can never render wider than its reserved gutter.
    expect(css).toMatch(
      /--context-rail-effective:\s*min\(\s*var\(--context-rail-width, 380px\),\s*max\(240px, calc\(100vw - var\(--sidebar-reserve, 408px\) - 448px\)\)\s*\);/
    );
    expect(css).toContain(
      "padding-right: calc(var(--context-rail-effective, 380px) + 48px);"
    );
    expect(css).toContain("width: var(--context-rail-effective, 380px);");
    // The narrow-width media query must NOT zero the rail gutter or drop the
    // header reserve to a fixed 56px anymore.
    expect(css).not.toMatch(
      /@media \(max-width: 1100px\)[\s\S]*?\.thread-header,[\s\S]*?padding-right:\s*56px;/
    );
    expect(css).not.toContain("the header reclaims the space");
    // The sidebar-hidden override must zero the reserve so the rail reclaims
    // the freed space instead of subtracting a sidebar that isn't on screen.
    expect(css).toMatch(
      /\.app-shell\[data-sidebar-hidden="true"\][^{]*\{[^}]*--sidebar-reserve:\s*0px;/
    );
  });

  it("keeps the live work rail inset to match the chat column", () => {
    // The bar carries 16px side margins, so its width must leave room for
    // them (`100% - 32px`). A bare `100%` plus the margins overflows once the
    // chat column is narrower than --chat-column-max (sidebar + context rail
    // both open), ramming the bar flush against both edges while the
    // composer/transcript stay inset. (The old in-transcript "sidebar" dock
    // is gone — edited files dock to the context-rail Edits panel — so the
    // inset contract now lives on the base .live-work-rail rule.)
    const rule = extractRuleBody(css, ".live-work-rail");
    expect(rule).toContain("width: min(100% - 32px, var(--chat-column-max));");
    expect(rule).toContain("margin: 0 16px 8px;");
  });

  it("keeps hidden thread row actions from stealing row clicks", () => {
    const actionsRule = extractRuleBody(css, ".thread-row__actions");

    expect(actionsRule).toContain("pointer-events: none;");
    expect(css).toMatch(
      /\.thread-row-shell:hover \.thread-row__chip--add-reaction,\s*\.thread-row__chip--add-reaction:focus-visible,\s*\.thread-row__chip--add-reaction\.is-open\s*\{[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/
    );
    expect(css).toMatch(
      /\.thread-row-shell:hover \.thread-row__overflow-button,\s*\.thread-row__overflow-button:focus-visible\s*\{[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/
    );
  });

  it("hides thread row timestamps behind focused or open row actions", () => {
    // Pins the FULL five-selector fade list (it once silently grew a
    // pin-button arm this regex didn't describe, so the test matched a
    // suffix and stopped being the authoritative statement of the
    // list). The pinned-row heading reserve mirrors this state set —
    // its own pin lives with the target-size block above.
    expect(css).toMatch(
      /\.thread-row-shell:has\(\.thread-row__pin-button:focus-visible\) \.thread-row__time,\s*\.thread-row-shell:hover \.thread-row__time,\s*\.thread-row-shell:has\(\.thread-row__overflow-button:focus-visible\) \.thread-row__time,\s*\.thread-row-shell:has\(\.thread-row__chip--add-reaction:focus-visible\) \.thread-row__time,\s*\.thread-row-shell:has\(\.thread-row__chip--add-reaction\.is-open\) \.thread-row__time\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?\}/
    );
  });

  it("keeps thread card reaction emoji the same size as picker emoji", () => {
    const baseChipIndex = css.indexOf(".thread-row__chip {");
    const reactionChipIndex = css.indexOf(
      ".thread-row__chip.thread-row__chip--reaction {"
    );
    expect(baseChipIndex).toBeGreaterThanOrEqual(0);
    expect(reactionChipIndex).toBeGreaterThan(baseChipIndex);

    const threadReactionRule = extractRuleBody(
      css,
      ".thread-row__chip.thread-row__chip--reaction"
    );
    const pickerReactionRule = extractRuleBody(css, ".reaction-picker__option");

    expect(threadReactionRule).toContain("font-size: 16px;");
    expect(pickerReactionRule).toContain("font-size: 16px;");
    expect(threadReactionRule).toContain("font-variant-emoji: emoji;");
    expect(pickerReactionRule).toContain("font-variant-emoji: emoji;");
  });

  it("keeps focused sticky directory summaries from painting outside the scrollport", () => {
    const headerRule = extractRuleBody(css, ".directory-row__header");

    expect(headerRule).toContain("position: sticky;");
    expect(headerRule).toContain("top: 0;");
    expect(headerRule).toContain("background: var(--bg-sidebar);");
    expect(css).toMatch(
      /\.directory-row__summary:focus,\s*\.directory-row__summary:focus-visible\s*\{[\s\S]*?outline-offset:\s*-2px;[\s\S]*?\}/
    );
  });

  // The thread row and star-map card draw their focus ring on the CARD via
  // `:has()`, because the focusable element inside them is a transparent
  // overlay button (see ThreadRow / StarMapThreadCard). That indirection is
  // exactly where a brand token drifts unnoticed: nothing else renders these
  // rings, so a wrong token or offset ships looking plausible. Both must name
  // `--focus-ring` — the semantic token, `var(--accent)` in both themes — and
  // each keeps its own offset: 2px on the sidebar row, 1px on the star-map
  // card, whose cards shingle so a wider ring bleeds onto the neighbour.
  // Changing either is a design decision; change this test in the same commit
  // so it is reviewed rather than accidental.
  it("draws both card focus rings from the focus-ring token at their own offsets", () => {
    // `extractRuleBody`, not a `[\s\S]*?` regex over the whole sheet: a lazy
    // span like that runs straight past the closing brace and can satisfy
    // itself from a LATER rule, so it passes on a wrong token. That is not
    // hypothetical — the first draft of this test did exactly that and waved
    // through a mutation to `--accent-bright` at the wrong offset.
    const rowRing = extractRuleBody(
      css,
      ".thread-row:has(.thread-row__open:focus)",
    );
    expect(rowRing).toContain("outline: 2px solid var(--focus-ring);");
    expect(rowRing).toContain("outline-offset: 2px;");

    const cardRing = extractRuleBody(
      css,
      ".star-map-card:has(.star-map-card__open:focus-visible)",
    );
    expect(cardRing).toContain("outline: 2px solid var(--focus-ring);");
    expect(cardRing).toContain("outline-offset: 1px;");
    // The star-map rule this replaced keyed off the card itself being
    // focusable. The card is a plain container now, so such a rule can never
    // match and would only mislead the next reader. (No equivalent assertion
    // for `.thread-row`: that class is still worn by a real `<button>` on
    // directory summaries, so a focus rule naming it is legitimate there.)
    expect(css).not.toMatch(/\.star-map-card:focus-visible\s*\{/);
  });

  it("does not pull an unpinned first directory thread under the sticky header", () => {
    // An empty pinned lane still renders its zero-height append target before
    // the first unpinned row. Its ordinary -2px margins cancel the 2px flex
    // gaps on both sides, but at :first-child there is no leading gap. Letting
    // that start margin survive reduced the row's 4px nominal clearance to
    // 2px, so the z-index 5 header covered the focus ring's 4px outside reach.
    const rowRing = extractRuleBody(
      css,
      ".thread-row:has(.thread-row__open:focus)",
    );
    const directoryDetails = extractRuleBody(css, ".directory-row__details");
    const pinDropBoundary = extractRuleBody(
      css,
      ".directory-row__pin-drop-boundary",
    );
    const leadingPinDropBoundary = extractRuleBody(
      css,
      ".directory-row__pin-drop-boundary:first-child",
    );
    const ringWidth = Number(
      rowRing.match(/outline:\s*(?<width>\d+)px\s+solid/)?.groups?.width,
    );
    const ringOffset = Number(
      rowRing.match(/outline-offset:\s*(?<offset>\d+)px/)?.groups?.offset,
    );
    const detailsTopPadding = Number(
      directoryDetails.match(/padding:\s*(?<top>\d+)px\s/)?.groups?.top,
    );

    expect(ringWidth).toBeGreaterThan(0);
    expect(ringOffset).toBeGreaterThanOrEqual(0);
    expect(detailsTopPadding).toBeGreaterThanOrEqual(ringWidth + ringOffset);
    expect(pinDropBoundary).toContain("margin-block: -2px;");
    expect(leadingPinDropBoundary).toContain("margin-block-start: 0;");
  });

  // The three focusable controls in the Star Map "View" popover: the chip that
  // opens it, each button of the layout switch, and the "Reset view" action.
  // They are ordinary `<button>`s, so they are tab-reachable whether or not
  // anyone styles the focused state — the layout switch shipped without a
  // `:focus-visible` rule at all and keyboard users simply had no idea where
  // focus was. Nothing automated caught it: axe cannot evaluate focus
  // visibility (it is not a computable property of the resting DOM), so the
  // a11y gate was green the whole time. This assertion IS the guard.
  //
  // All three name `--focus-ring` at 1px, matching the star-map card ring
  // above. Dropping one, or drifting a token/offset, is a design decision —
  // change this test in the same commit so it is reviewed, not accidental.
  it("draws every Star Map view-popover focus ring from the focus-ring token", () => {
    for (const selector of [
      ".star-map__filter-chip:focus-visible",
      ".star-map__layout-option:focus-visible",
      ".star-map__view-action:focus-visible",
    ]) {
      const ring = extractRuleBody(css, selector);
      expect(ring).toContain("outline: 2px solid var(--focus-ring);");
      expect(ring).toContain("outline-offset: 1px;");
    }
  });

  it("keeps long directory names from crowding the count and expand control", () => {
    const summaryRule = extractRuleBody(css, ".directory-row__summary");
    const summaryMetaRule = extractRuleBody(css, ".directory-row__summary-meta");

    expect(summaryRule).toContain("display: grid;");
    expect(summaryRule).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(summaryRule).toContain("align-items: center;");
    expect(summaryMetaRule).toContain("flex: 0 0 auto;");
  });

  it("suppresses the selection-indicator bar on directory-summary rows so it can't paint over the folder icon", () => {
    // `.directory-row__summary` reuses `.thread-row` for typography and
    // selection tokens, but tightens its lateral padding to 4px so the
    // folder icon sits close to the row edge. The base
    // `.thread-row.is-selected::before` accent bar (positioned at
    // left:5px, width:3px) would paint over the folder icon under that
    // tighter inset. The header already conveys selection via the
    // accent border + tinted background from `.thread-row.is-selected`,
    // so the redundant bar is suppressed via `content: none`. If this
    // override is removed, the orange bar reappears across the folder
    // glyph the next time a directory header is selected.
    const overrideRule = extractRuleBody(
      css,
      ".directory-row__summary.is-selected::before",
    );
    expect(overrideRule).toContain("content: none;");
  });

  it("keeps thread context menu hover states visible (skipping disabled rows)", () => {
    // The `:not(:disabled)` qualifier was added so disabled menu
    // items (Move Up at top of pinned list / Move Down at bottom)
    // don't pick up the accent hover treatment — they stay muted
    // to telegraph that nothing happens on click.
    expect(css).toMatch(
      /\.thread-context-menu button:hover:not\(:disabled\),\s*\.thread-context-menu button:focus-visible:not\(:disabled\)\s*\{[\s\S]*?background:\s*var\(--accent-soft\);[\s\S]*?color:\s*var\(--accent-bright\);[\s\S]*?\}/
    );
    // Disabled state uses text-muted so the row reads as
    // "present but inert" rather than fully hidden — keeps the
    // menu height stable as the user walks the pinned list.
    const disabledRule = extractRuleBody(
      css,
      ".thread-context-menu button:disabled",
    );
    expect(disabledRule).toContain("color: var(--text-muted);");
  });

  it("layers toast thread-chip menus above the toast stack", () => {
    const toastStackRule = extractRuleBody(css, ".app-toast-stack");
    const toastThreadMenuRule = extractRuleBody(
      css,
      ".app-notice-toast__thread-menu",
    );
    expect(readZIndex(toastThreadMenuRule)).toBeGreaterThan(
      readZIndex(toastStackRule),
    );
  });

  it("scopes the Star Map window's card z-scale inside its own stacking context", () => {
    // The dedicated map window's root must open a stacking context: the
    // map's internal card z-scale runs to STAR_MAP_CARD_MAX_Z (4000), and
    // without the containment those cards would out-stack every
    // body-portaled tooltip in the window.
    const windowRule = extractRuleBody(css, ".star-map-window");
    expect(windowRule).toContain("position: relative;");
    expect(windowRule).toMatch(/z-index:\s*\d+;/);
  });

  it("gives the full-bleed Star Map window a glass drag strip that its top chrome punches through", () => {
    // macOS `hiddenInset` leaves the map with stoplights but no native
    // title-bar band, and the sky underneath is a pan handle, so the
    // transparent strip is the only place the operator can grab the window.
    // The two clusters that live inside it must opt out, or their pixels
    // fall back to window-drag hit-testing and swallow the click.
    const stripRule = extractRuleBody(css, ".star-map-window__titlebar");
    expect(stripRule).toContain("-webkit-app-region: drag;");
    expect(stripRule).toContain("position: absolute;");
    expect(stripRule).toContain("backdrop-filter:");
    // Below the top band it hosts, above the canvas.
    const bandRule = extractRuleBody(css, ".star-map__top-band");
    expect(readZIndex(stripRule)).toBeLessThan(readZIndex(bandRule));
    // The band is full width, so it is the one element in the strip that
    // must NOT opt out: a no-drag rect across the whole band would leave
    // macOS with no handle on this window at all. It passes its pointer
    // events through for the same reason - the gaps between its slots are
    // drag strip, not chrome.
    expect(bandRule).not.toContain("-webkit-app-region");
    expect(bandRule).toContain("pointer-events: none;");
    // Its slots take both back. Declared on the band's descendants rather
    // than per slot, so a control added to any slot is clickable without
    // anyone remembering this rule exists.
    expect(css).toMatch(
      /\.star-map__top-band > \*,\s*\.star-map__top-band > \* \*\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
    );
    // …except the wordmark, which is brand, not a control: on macOS
    // pressing it must drag the window like the main window's masthead
    // brand, never start a text selection. The compound scope
    // out-specifies the band rule's universal legs, so source order is
    // free. darwin-only, because the glass strip the rule belongs to only
    // renders there — on Windows the band sits over the sky below the
    // painted titlebar, and on Linux the OS frame ignores drag regions,
    // where `pointer-events: none` alone would turn a wordmark press into
    // a canvas pan.
    const brandOverride = extractRuleBody(
      css,
      ':root[data-platform="darwin"] .star-map__chrome .sidebar__brand,\n'
        + ':root[data-platform="darwin"] .star-map__chrome .sidebar__brand *',
    );
    expect(brandOverride).toContain("-webkit-app-region: drag;");
    expect(brandOverride).toContain("pointer-events: none;");
    // The dedicated window locks chrome text selection at the root the way
    // `.app-shell` does — dragging across the wordmark or a chip label must
    // not paint a selection. Copyable content opts back in per component.
    // Asserted per form: a bare `toContain("user-select: none;")` is
    // satisfied by the `-webkit-` line's substring alone.
    const mapWindowRule = extractRuleBody(css, ".star-map-window");
    expect(mapWindowRule).toContain("-webkit-user-select: none;");
    expect(mapWindowRule).toMatch(/(?<!-)user-select: none;/);
    // The card-level dialogs are body-portaled and full-window, so their
    // scrim overlaps the strip's rect and would otherwise turn a
    // dismiss-click near the top into a window drag. Both are named here:
    // a second dialog that forgets the punch-out fails the same way the
    // first one would have.
    expect(css).toMatch(
      /\.star-map-intake,\s*\.star-map-intake \*,\s*\.star-map-rename,\s*\.star-map-rename \*\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;[\s\S]*?\}/,
    );
    // The ⌘K jump palette is the third body-portaled overlay whose top
    // edge overlaps a drag strip — the map's glass strip, and the main
    // window's masthead/thread-header band — so it rides the same
    // punch-out rule as intake/rename.
    expect(css).toMatch(
      /\.jump-palette,\s*\.jump-palette \*,\s*\.star-map-intake,/,
    );
    // Canvas residents must NOT opt out. Every map resident — thread
    // cards, instances, cluster labels, load cards, AND the chat cards
    // with their satellites (the JSX at their render site puts them
    // INSIDE `.star-map__canvas`, whatever older comments claimed) —
    // paints below the glass in the canvas stacking context, so in the
    // band none of them is interactive. But drag regions are rect unions
    // independent of z-order, so a resident whose rect clips into the
    // band would punch an invisible card-width dead hole in the window's
    // only drag handle. That was a shipped bug: a ~200px strip next to
    // the filter chips that refused to drag the window.
    //
    // Comments are stripped first so a class named in prose cannot start
    // a match, and each token is a deliberate prefix: the ban covers
    // every BEM descendant and modifier of the family.
    const cssSansComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const canvasResident of [
      "\\.star-map-card",
      "\\.star-map-instance",
      "\\.star-map-load-card",
      "\\.star-map-chat-card",
      "\\.star-map-satellite-card",
      "\\.star-map__cluster-label",
      "\\.star-map__cluster-overflow",
    ]) {
      expect(cssSansComments).not.toMatch(
        new RegExp(
          `${canvasResident}[^{}]*\\{[^}]*-webkit-app-region:\\s*no-drag`,
        ),
      );
    }
    // The edge brightens whenever the sky moves under it — pointer pan and
    // keyboard flight alike — and the strip disappears in fullscreen, where
    // there is no window to drag.
    expect(css).toMatch(
      /\.star-map-window:has\(\.star-map__viewport\.is-panning, \.star-map\.is-flying\)\s*\.star-map-window__titlebar::before,/,
    );
    expect(css).toMatch(
      /:root\[data-fullscreen="true"\] \.star-map-window__titlebar\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/,
    );
  });

  it("gives floating Star Map cards an edge the eye can find on a black sky", () => {
    // Chat cards and their satellites float over the sky and over each
    // other. The sky is black and the card surface one step above it, so
    // a dark popover shadow alone vanishes where one card overlaps the
    // next, and a `--border-subtle` edge weighs the same as the message
    // bubbles inside the card — the operator could not see where one card
    // stopped and the next began. Both families must read the shared
    // float tokens (edge and lift treatment), and the dark theme must
    // keep the light halo that separates a card from the sky.
    for (const selector of [".star-map-chat-card", ".star-map-satellite-card"]) {
      const rule = extractRuleBody(css, selector);
      expect(rule).toContain("border: 1px solid var(--star-map-float-border);");
      expect(rule).toContain("box-shadow: var(--star-map-float-shadow);");
      expect(rule).not.toContain("var(--border-subtle)");
      expect(rule).not.toContain("var(--shadow-popover)");
    }
    const darkRoot = extractRuleBody(css, ":root");
    expect(darkRoot).toMatch(
      /--star-map-float-border:\s*color-mix\(in srgb, var\(--text-primary\) \d+%, transparent\);/,
    );
    // Inner highlight, 1px dark ring, light halo, lift shadow — in that
    // order, so the ring sits between the rim and the glow.
    expect(darkRoot).toMatch(
      /--star-map-float-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--text-primary\) \d+%, transparent\),\s*0 0 0 1px color-mix\(in srgb, var\(--shadow-base\) \d+%, transparent\),\s*0 0 0 2px color-mix\(in srgb, var\(--text-primary\) \d+%, transparent\),\s*0 0 \d+px color-mix\(in srgb, var\(--text-primary\) \d+%, transparent\),\s*0 \d+px \d+px color-mix\(in srgb, var\(--shadow-base\) \d+%, transparent\);/,
    );
    // Light theme drops the glow (invisible on white) and softens the
    // ring so it does not read as a drawn outline.
    const lightRoot = extractRuleBody(css, ':root[data-theme="light"]');
    expect(lightRoot).toContain("--star-map-float-border: var(--border-strong);");
    expect(lightRoot).toMatch(/--star-map-float-shadow:\s*inset 0 0 0 1px/);
    expect(lightRoot).not.toMatch(
      /--star-map-float-shadow:[^;]*,\s*0 0 \d+px color-mix\(in srgb, var\(--text-primary\)/,
    );
  });

  it("lays the Star Map's top band out as one row its controls cannot escape", () => {
    // The band's clusters used to position themselves independently —
    // chrome pinned to the left edge, chips translated to the window's
    // centre — with nothing reserving space between them, so the chrome
    // painted over the first filter chip and swallowed its clicks. Flex
    // items cannot overlap; this is the assertion that the row stays a
    // row rather than reverting to islands.
    const bandRule = extractRuleBody(css, ".star-map__top-band");
    expect(bandRule).toContain("display: flex;");
    // Left-aligned, not centred. The filters are the same kind of control
    // as Find and View and belong beside them; a centred strip drifts with
    // the window while the chrome does not, which is what put the two on a
    // collision course. A `grid-template-columns` here means someone has
    // gone back to spacer tracks.
    expect(bandRule).not.toContain("grid-template-columns");
    expect(bandRule).not.toContain("justify-content: center;");
    // The one slot that is not in reading order: actions stay pinned right
    // whatever the left group does.
    expect(extractRuleBody(css, ".star-map__actions")).toContain(
      "margin-left: auto;",
    );

    const chromeRule = extractRuleBody(css, ".star-map__chrome");
    const filtersRule = extractRuleBody(css, ".star-map__filters");
    // Neither slot positions itself any more; the band decides where they
    // sit. A `position: absolute` creeping back into either one is the
    // regression, not a style preference.
    expect(chromeRule).not.toContain("position: absolute;");
    expect(filtersRule).not.toContain("position: absolute;");
  });

  it("degrades the Star Map's filter strip by measurement, not by breakpoint", () => {
    // Two earlier answers to a strip that does not fit were both wrong.
    // Wrapping put a second row of chips over the star field and doubled
    // the band's height; a fixed 1120px breakpoint threw the whole strip
    // away well before it had to, because the chips carry live counts and
    // the width they need is a property of the DATA (642px at one digit,
    // 668px at two, 732px at three), not of the window.
    expect(css).not.toMatch(/@media[^{]*\{\s*\.star-map__filter-strip/);
    const stripRule = extractRuleBody(css, ".star-map__filter-strip");
    expect(stripRule).toContain("flex-wrap: nowrap;");

    // The hidden rendering is taken out of FLOW, never out of layout.
    // `display: none` would zero the widths `resolveFilterFit` measures,
    // the strip would look like it fits, and the band would flip between
    // states every frame. This pair of selectors is load bearing for that
    // — and `width: max-content` is what keeps the measurement honest once
    // a chip is out of its flex row.
    const hiddenRule = extractRuleBody(
      css,
      ".star-map__filters.is-reduced .star-map__filter-chip.is-dropped,\n"
        + ".star-map__filters.is-collapsed .star-map__filter-strip",
    );
    expect(hiddenRule).toContain("visibility: hidden;");
    expect(hiddenRule).toContain("position: absolute;");
    expect(hiddenRule).toContain("width: max-content;");
    expect(hiddenRule).not.toContain("display: none;");

    // The strip clips a row that has outgrown it, but the clip edge falls
    // exactly on the first and last chip's box and the focus ring is drawn
    // OUTSIDE that box (2px at `outline-offset: 1px`). With plain
    // `overflow: hidden` the ring on the edge chips lost its outer 3px —
    // measured as three fully blank pixel columns where the accent should
    // be — and no axe rule covers it.
    expect(stripRule).toContain("overflow: clip;");
    expect(stripRule).toContain("overflow-clip-margin: 4px;");
    expect(stripRule).not.toContain("overflow: hidden;");

    // The collapsed menu is the only thing that appears rather than
    // disappears, so it is hidden by default and shown by the state class.
    expect(extractRuleBody(css, ".star-map__filter-menu")).toContain(
      "display: none;",
    );
    expect(
      extractRuleBody(
        css,
        ".star-map__filters.is-collapsed .star-map__filter-menu",
      ),
    ).toContain("display: block;");
  });

  it("right-aligns the keyboard shortcut hint chip on context menu items", () => {
    // The `__shortcut` chip is the discoverability surface for
    // the otherwise-invisible Cmd+(Shift+)Arrow reorder shortcut.
    // Visual contract: muted color by default, tracks the parent
    // button's accent color on hover so it doesn't drop out of
    // the highlighted row.
    const shortcutRule = extractRuleBody(
      css,
      ".thread-context-menu__shortcut",
    );
    expect(shortcutRule).toContain("margin-left: auto;");
    expect(shortcutRule).toContain("color: var(--text-muted);");
    expect(css).toMatch(
      /\.thread-context-menu button:hover:not\(:disabled\) \.thread-context-menu__shortcut,\s*\.thread-context-menu button:focus-visible:not\(:disabled\) \.thread-context-menu__shortcut\s*\{[\s\S]*?color:\s*var\(--accent-bright\);[\s\S]*?\}/
    );
  });

  it("keeps composer autocomplete visually separated from transcript surfaces", () => {
    const autocompleteRule = extractRuleBody(css, ".composer__autocomplete");
    const directoryAutocompleteRule = extractRuleBody(
      css,
      ".composer__autocomplete--directories",
    );
    const hashAutocompleteRule = extractRuleBody(
      css,
      ".composer__autocomplete--hash-references",
    );
    const directoryOptionRule = extractRuleBody(
      css,
      ".composer__autocomplete--directories .composer__autocomplete-option:not(.composer__autocomplete-option--action)",
    );
    const directoryMetaRule = extractRuleBody(
      css,
      ".composer__autocomplete--directories .composer__autocomplete-meta",
    );

    expect(autocompleteRule).toContain("border: 1px solid var(--border-strong);");
    expect(autocompleteRule).toContain("background: var(--bg-panel-elevated);");
    expect(autocompleteRule).toContain(
      "inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 6%, transparent)",
    );
    expect(autocompleteRule).not.toContain("background: rgba(10, 10, 10, 0.98);");
    expect(directoryAutocompleteRule).toContain("right: auto;");
    expect(directoryAutocompleteRule).toContain("width: min(100%, 440px);");
    expect(hashAutocompleteRule).toContain("right: auto;");
    expect(hashAutocompleteRule).toContain("width: min(100%, 440px);");
    expect(directoryAutocompleteRule).toContain(
      "border-color: var(--border-subtle);",
    );
    expect(directoryAutocompleteRule).toContain(
      "box-shadow: var(--shadow-popover);",
    );
    expect(directoryOptionRule).toContain(
      "grid-template-columns: minmax(0, 160px) minmax(0, 1fr);",
    );
    expect(directoryOptionRule).toContain("min-height: 38px;");
    expect(directoryMetaRule).toContain("text-align: right;");
    expect(directoryMetaRule).toContain("white-space: nowrap;");
  });

  it("locks composer height contract — compact when empty, grows, capped at 280px", () => {
    // Issue #240 follow-up: the composer's min-height is the
    // empty-state floor; max-height is the clamp the editor scrolls
    // inside once the user has typed enough to fill it. Both values
    // are visual contracts — bumping min-height back up steals
    // transcript reading area; lifting max-height above the cap
    // pushes the picker rows off-screen on shorter viewports. Lock
    // them so a future innocuous-looking edit doesn't undo the
    // intent.
    //
    // 48px is the exact one-line height: 14px text at line-height 1.6
    // (22.4px) + 12px padding top and bottom + 1px border each side
    // ≈ 48.4px. It was 56px, which overshot by ~8px — and because the
    // editor text is top-aligned, that surplus rendered entirely
    // BELOW the caret line, so the empty composer read as 12px above
    // the text and ~19.6px below. The floor must never exceed the
    // natural one-line height or the asymmetry comes back.
    const tiptapRule = extractRuleBody(css, ".composer-tiptap-input");
    expect(tiptapRule).toMatch(/min-height:\s*48px;/);
    expect(tiptapRule).toMatch(/max-height:\s*280px;/);
    expect(tiptapRule).toMatch(/overflow-y:\s*auto;/);

    // The inner editor's min-height tracks the outer container's
    // (-2 for the 1px border on each side of the wrapper) so the
    // editor visually fills the wrapper at the empty-state floor.
    const editorRule = extractRuleBody(css, ".composer-tiptap-input__editor");
    expect(editorRule).toMatch(/min-height:\s*46px;/);

    // The dead `<textarea>` variant (`.composer__input`) used to be
    // pinned here too, on the theory that it shared the floor. It had
    // no renderer references and its floor never applied (a textarea
    // sizes from `rows`, default 2), so the rule is gone. Assert it
    // stays gone rather than silently growing a second, unrendered
    // height contract to keep in sync.
    expect(css).not.toContain(".composer__input {");
  });

  it("uses --accent (not --accent-bright) for every brand-accent mark", () => {
    // The visual brand `Pwr<accent>Agent</accent>` reads identically
    // wherever it appears (main sidebar, Settings nav, Activity
    // window titlebar). Picking --accent-bright instead of --accent
    // produced a mismatched lighter shade in the Activity window
    // — caught visually only after the window shipped.
    //
    // Lock the contract: every `__brand-accent` rule must use
    // `var(--accent)`. If a future window/strip needs a different
    // accent, change THIS test deliberately along with the rule.
    const brandAccentSelectors = [
      ".sidebar__brand-accent",
      ".settings-nav__brand-accent",
      ".activity-titlebar__brand-accent",
    ];
    for (const selector of brandAccentSelectors) {
      const rule = extractRuleBody(css, selector);
      expect(rule, `${selector} must use var(--accent)`).toContain(
        "color: var(--accent);",
      );
      expect(rule, `${selector} must NOT use var(--accent-bright)`).not.toContain(
        "color: var(--accent-bright);",
      );
    }
  });

  it("`SettingsSection` and `SettingsPathRow` chips share the same tone CSS modifiers", () => {
    // Both primitives now consume the shared `SettingsChipTone` enum
    // (default | muted | ok | err | warn). Lock the CSS rules so a
    // future PR that adds a new tone to one primitive can't silently
    // skip the other.
    for (const tone of ["ok", "err", "warn"] as const) {
      expect(
        css,
        `.settings-card__chip--${tone} should be defined`,
      ).toMatch(new RegExp(`\\.settings-card__chip--${tone}\\s*\\{`));
      expect(
        css,
        `.settings-pathrow__chip--${tone} should be defined`,
      ).toMatch(new RegExp(`\\.settings-pathrow__chip--${tone}\\s*\\{`));
    }
  });

  it("lets SettingsSection own the archive section header divider", () => {
    // Archive rows live directly inside a SettingsSection body. Adding
    // a second top border to the thread container stacks with the
    // SettingsSection header divider and makes the pane visibly heavier
    // than neighboring settings panes.
    expect(css).not.toMatch(
      /\.settings-archive-project__threads\s*\{[\s\S]*?border-top:/,
    );
  });

  it("keeps Activity and Settings titlebar breadcrumbs visually identical", () => {
    // The Activity window's titlebar mirrors the Settings overlay's
    // right-pane titlebar — same eyebrow color, same separator
    // color, same current-segment color, same breadcrumb container
    // styling. Drift between the two reads as a visual bug.
    const settingsBreadcrumb = extractRuleBody(
      css,
      ".settings-titlebar__breadcrumb",
    );
    const activityBreadcrumb = extractRuleBody(
      css,
      ".activity-titlebar__breadcrumb",
    );
    for (const fragment of [
      "color: var(--text-muted);",
      "font-size: 12px;",
      "font-weight: 500;",
      "gap: 6px;",
    ]) {
      expect(settingsBreadcrumb).toContain(fragment);
      expect(activityBreadcrumb).toContain(fragment);
    }

    const settingsEyebrow = extractRuleBody(css, ".settings-titlebar__eyebrow");
    const activityEyebrow = extractRuleBody(css, ".activity-titlebar__eyebrow");
    expect(settingsEyebrow).toContain("color: var(--accent);");
    expect(activityEyebrow).toContain("color: var(--accent);");
    expect(activityEyebrow).not.toContain("color: var(--text-muted);");

    const settingsSeparator = extractRuleBody(
      css,
      ".settings-titlebar__separator",
    );
    const activitySeparator = extractRuleBody(
      css,
      ".activity-titlebar__separator",
    );
    expect(settingsSeparator).toContain("color: var(--text-muted);");
    expect(activitySeparator).toContain("color: var(--text-muted);");
    expect(activitySeparator).not.toContain("color: var(--text-subtle);");

    const settingsCurrent = extractRuleBody(css, ".settings-titlebar__current");
    const activityCurrent = extractRuleBody(css, ".activity-titlebar__current");
    expect(settingsCurrent).toContain("color: var(--text-primary);");
    expect(activityCurrent).toContain("color: var(--text-primary);");
  });

  it("drops titlebar stoplight gutters outside macOS and Windows", () => {
    const activityTitlebar = extractRuleBody(css, ".activity-titlebar");
    const sidebarMasthead = extractRuleBody(css, ".sidebar__masthead");
    const settingsMasthead = extractRuleBody(css, ".settings-nav__masthead");

    expect(activityTitlebar).toContain("padding: 10px 14px 0 96px;");
    expect(sidebarMasthead).toContain("padding: 10px 0 0 80px;");
    expect(settingsMasthead).toContain("padding: 10px 0 0 80px;");
    expect(css).toMatch(
      /:root\[data-platform\]:not\(\[data-platform="darwin"\]\):not\(\[data-platform="win32"\]\)\s*\.activity-titlebar\s*\{[\s\S]*?padding-left:\s*14px;[\s\S]*?\}/,
    );
    // On Windows the aux windows are frameless with the OS caption buttons at
    // the top-right, so .activity-titlebar drops the left stoplight gutter and
    // instead reserves the caption-button width on the right.
    expect(css).toMatch(
      /:root\[data-platform="win32"\]\s*\.activity-titlebar\s*\{[\s\S]*?padding-left:\s*14px;[\s\S]*?padding-right:\s*var\(--win-caption-w[\s\S]*?\}/,
    );
    // The main sidebar masthead drops the stoplight gutter on every non-macOS
    // platform now: Linux has a normal frame, and on Windows the masthead is
    // hidden entirely (its wordmark + action buttons moved into the custom
    // .app-titlebar strip), so there is no left reservation to keep.
    expect(css).toMatch(
      /:root\[data-platform\]:not\(\[data-platform="darwin"\]\)\s*\.sidebar__masthead\s*\{[\s\S]*?padding-left:\s*0;[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /:root\[data-platform="win32"\]\s*\.sidebar__masthead\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /:root\[data-platform\]:not\(\[data-platform="darwin"\]\):not\(\[data-platform="win32"\]\)\s*\.settings-nav__masthead\s*\{[\s\S]*?padding-left:\s*0;[\s\S]*?\}/,
    );
    // Settings and Automations use the same Windows title strip as the main
    // shell, so their in-nav wordmarks would duplicate the one visible there.
    expect(css).toMatch(
      /:root\[data-platform="win32"\]\s*:is\(\.settings-screen,\s*\.automations-screen\)\s*\.settings-nav__masthead\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/,
    );
  });

  it("mirrors thread-row drop-indicator + recents divider tokens for directory pinning", () => {
    // Plan 2026-05-09-002 Units L + P. The directory-pin CSS is
    // explicitly a steal-the-pattern of the thread-pin CSS: the
    // drop-indicator pseudo-elements on `.directory-row__header`
    // mirror `.thread-row-shell.is-drop-target-*`, and the
    // `.directories-pinned-divider` rules mirror
    // `.recents-pinned-divider` token-for-token (only the label
    // text differs). If a future PR retunes the thread-pin look
    // without touching the directory-pin look, the brand starts
    // drifting between the Recents and Directories lenses. Lock
    // the token parity so that kind of drift is caught at PR
    // time, not visually after merge.
    const draggableRule = extractRuleBody(
      css,
      '.directory-row__header[draggable="true"]',
    );
    expect(draggableRule).toContain("cursor: grab;");
    const activeRule = extractRuleBody(
      css,
      '.directory-row__header[draggable="true"]:active',
    );
    expect(activeRule).toContain("cursor: grabbing;");

    // Drop-indicator pseudo-elements: 3px accent bar with shadow,
    // positioned above (before) / below (after) the directory
    // section. Attached to `.directory-row` (not the header) so
    // the indicator stretches the full height of an expanded
    // directory's drop zone.
    expect(css).toMatch(
      /\.directory-row\.is-drop-target-before::before,\s*\.directory-row\.is-drop-target-after::after\s*\{[\s\S]*?height:\s*3px;[\s\S]*?background:\s*var\(--accent\);[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /\.directory-row\.is-drop-target-before::before\s*\{[\s\S]*?top:\s*-3px;[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /\.directory-row\.is-drop-target-after::after\s*\{[\s\S]*?bottom:\s*-3px;[\s\S]*?\}/,
    );

    // The pinned-directories divider must read identically to the
    // Recents pinned divider — same layout, same color, same
    // active state. Compare rule bodies token-for-token.
    const recentsDivider = extractRuleBody(css, ".recents-pinned-divider");
    const directoriesDivider = extractRuleBody(
      css,
      ".directories-pinned-divider",
    );
    for (const fragment of [
      "display: flex;",
      "gap: 8px;",
      "margin: 2px 6px;",
      "color: var(--text-muted);",
      "font-size: 11px;",
      "font-weight: 600;",
      "text-transform: uppercase;",
    ]) {
      expect(recentsDivider).toContain(fragment);
      expect(directoriesDivider).toContain(fragment);
    }

    // The Directory threads disclosure reuses the divider primitive.
    // A late `font:` shorthand would reset the inherited 11px divider
    // size to the sidebar row size, making this label visibly oversized.
    const directoryThreadsDivider = extractRuleBody(
      css,
      ".directory-row__thread-divider",
    );
    expect(directoryThreadsDivider).not.toMatch(/(?:^|\s)font\s*:/);
    expect(directoryThreadsDivider).toContain("font-family: inherit;");

    const recentsActive = extractRuleBody(
      css,
      ".recents-pinned-divider.is-drop-target",
    );
    const directoriesActive = extractRuleBody(
      css,
      ".directories-pinned-divider.is-drop-target",
    );
    expect(recentsActive).toContain("color: var(--accent-bright);");
    expect(directoriesActive).toContain("color: var(--accent-bright);");

    // Active-state pseudo-elements turn the rule strands into the
    // 3px accent bar.
    expect(css).toMatch(
      /\.directories-pinned-divider\.is-drop-target::before,\s*\.directories-pinned-divider\.is-drop-target::after\s*\{[\s\S]*?height:\s*3px;[\s\S]*?background:\s*var\(--accent\);[\s\S]*?\}/,
    );
  });

  it("wraps long unbroken strings inside inline `code` spans instead of forcing horizontal scroll", () => {
    // A pasted long URL inside single backticks renders as
    // `<code class="transcript-message__code">…</code>`. The element is
    // `display: inline-block` for the padded chip look, which by default
    // sizes to its intrinsic content width — so an unbroken URL stretches
    // the inline-block past the message column and pushes the surrounding
    // transcript into horizontal scroll.
    //
    // Lock `overflow-wrap: anywhere;` on the inline code chip so the
    // browser is allowed to break the string at any character when it
    // would otherwise overflow, and pair it with `max-width: 100%;` so
    // the chip cannot exceed the message column.
    const inlineCodeRule = extractRuleBody(css, ".transcript-message__code");
    expect(inlineCodeRule).toContain("overflow-wrap: anywhere;");
    expect(inlineCodeRule).toContain("max-width: 100%;");
  });

  it("overlays the inline code copy affordance on hover and keyboard focus", () => {
    const inlineCodeWrapperRule = extractRuleBody(
      css,
      ".transcript-message__inline-code",
    );
    expect(inlineCodeWrapperRule).toContain("position: relative;");
    expect(inlineCodeWrapperRule).toContain("max-width: 100%;");
    expect(inlineCodeWrapperRule).toContain("vertical-align: baseline;");

    const inlineCopyRule = extractRuleBody(css, ".transcript-copy-button--inline");
    expect(inlineCopyRule).toContain("opacity: 1;");
    expect(inlineCopyRule).toContain("background: transparent;");
    expect(inlineCopyRule).not.toContain("vertical-align: text-bottom;");
    expect(css).not.toMatch(
      /\.transcript-message__inline-code \.transcript-message__code\s*\{/,
    );

    const inlineOverlayRule = extractRuleBody(
      css,
      ".transcript-copy-button--inline::after",
    );
    expect(inlineOverlayRule).toContain("border: 1px solid var(--border-subtle);");
    expect(inlineOverlayRule).toContain(
      "background: color-mix(in srgb, var(--bg-panel-elevated) 92%, transparent);",
    );

    expect(css).toMatch(
      /\.transcript-copy-button--inline:hover::before,\s*\.transcript-copy-button--inline:focus-visible::before,[\s\S]*?\{[\s\S]*?opacity:\s*1;[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /\.transcript-copy-button--inline:hover::after,\s*\.transcript-copy-button--inline:focus-visible::after,[\s\S]*?\{[\s\S]*?border-color:\s*var\(--accent-border\);[\s\S]*?opacity:\s*1;[\s\S]*?\}/,
    );
  });

  it("wraps fenced code blocks the same way the composer does", () => {
    // The composer's `<pre>` uses `white-space: pre-wrap` so a pasted
    // long line wraps inside the input rather than scrolling. The
    // transcript previously rendered fenced blocks with
    // `overflow-x: auto` + `white-space: pre`, which meant the same
    // text the user typed in the composer rendered with horizontal
    // scroll once it landed in the transcript. Mirror the composer:
    // `pre-wrap` preserves newlines + indentation but lets soft lines
    // wrap, and `overflow-wrap: anywhere` lets unbroken strings (URLs,
    // long identifiers) break at any character. The inner `<code>`
    // inherits both so its `white-space: pre` default doesn't override
    // the pre's wrap.
    const preRule = extractRuleBody(css, ".transcript-message__pre");
    expect(preRule).toContain("white-space: pre-wrap;");
    expect(preRule).toContain("overflow-wrap: anywhere;");
    expect(preRule).not.toContain("overflow-x: auto;");

    const preCodeRule = extractRuleBody(css, ".transcript-message__pre code");
    expect(preCodeRule).toContain("white-space: inherit;");
    expect(preCodeRule).toContain("overflow-wrap: inherit;");
    expect(preCodeRule).not.toContain("white-space: pre;");
  });

  it("wraps unbroken plain-text runs in transcript paragraphs and lists instead of overflowing the chat column", () => {
    // A monitor-subagent report pasted a pnpm progress separator — an
    // 80-char unbroken `++++…` run — into a user message. The run lands
    // as plain text in `<p class="transcript-message__paragraph">`
    // (remark-breaks keeps the surrounding log lines in one paragraph),
    // and an unbroken run has no soft break opportunities. Unlike the
    // inline-code chip and fenced-pre paths locked above, the paragraph
    // and list rules declare no overflow-wrap, so the run renders at its
    // intrinsic width, escapes the .transcript-message card edge, and
    // forces a horizontal scrollbar on the entire transcript.
    //
    // Lock `overflow-wrap: anywhere;` on both plain-text containers
    // (the property inherits, so `<li>` children of __list pick it up).
    // It is deliberately NOT placed on a shared ancestor like
    // .transcript-message__text: inherited overflow-wrap reaches table
    // cells too, where `anywhere` changes min-content sizing and would
    // defeat the wide-table horizontal scroll affordance.
    const paragraphRule = extractRuleBody(css, ".transcript-message__paragraph");
    expect(paragraphRule).toContain("overflow-wrap: anywhere;");

    const listRule = extractRuleBody(css, ".transcript-message__list");
    expect(listRule).toContain("overflow-wrap: anywhere;");
  });

  it("bounds long transcript code and quote blocks with their own vertical scroll", () => {
    const preRule = extractRuleBody(css, ".transcript-message__pre");
    expect(preRule).toContain("max-height:");
    expect(preRule).toContain("overflow-y: auto;");
    expect(preRule).toContain("scrollbar-gutter: stable;");

    const quoteRule = extractRuleBody(css, ".transcript-message__blockquote");
    expect(quoteRule).toContain("max-height:");
    expect(quoteRule).toContain("overflow-y: auto;");
    expect(quoteRule).toContain("overflow-x: hidden;");
    expect(quoteRule).toContain("scrollbar-gutter: stable;");

    const focusRule = extractRuleBody(
      css,
      ".transcript-message__blockquote:focus-visible,\n.transcript-message__pre:focus-visible"
    );
    expect(focusRule).toContain("outline: 2px solid var(--focus-ring);");
    expect(focusRule).toContain("outline-offset: 2px;");

    expect(css).not.toContain("transcript-message__collapse-toggle");
  });

  it("styles the sidebar scroll lanes with scrollbar-width only (no ::-webkit-scrollbar fat-flicker)", () => {
    // Regression guard. A `::-webkit-scrollbar` block on these lanes
    // makes Chromium render a fat *custom* scrollbar whenever it drops
    // into classic-scrollbar mode (a mouse is attached, "Show scroll
    // bars: Always" is set, or transiently while another app grabs the
    // screen) — the webkit width overrides `scrollbar-width: thin`, so
    // the bar visibly jumps fat and snaps back. The lanes must style the
    // scrollbar ONLY via the standard properties so it stays thin in
    // both overlay and classic modes.
    // Each lane appears in more than one rule (a shared base rule plus
    // its dedicated scroll rule), so collect every rule body for the
    // selector and assert the scroll rule among them opts into thin.
    for (const selector of [".sidebar-list--dense", ".directory-groups"]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bodies = [
        ...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g")),
      ].map((match) => match[1]);
      expect(bodies.some((body) => body.includes("scrollbar-width: thin;"))).toBe(
        true
      );
    }
    expect(css).not.toMatch(
      /\.(?:sidebar-list--dense|directory-groups)::-webkit-scrollbar/
    );
  });

  it("keeps the directory pin boundary neutral in both densities", () => {
    // Both densities share one 2px list gap since the 2026-08 inter-card
    // spacing pass, so a single boundary compensation pairs with it — the
    // boundary stays layout-neutral as long as these two values match.
    expect(
      extractRuleBody(css, ".sidebar-list,\n.directory-groups"),
    ).toContain("gap: 2px;");
    expect(
      extractRuleBody(css, ".directory-row__pin-drop-boundary"),
    ).toContain("margin-block: -2px;");
  });

  it("aligns the sidebar masthead and lanes to one shared inset system", () => {
    // Regression guard. The thread/directory lanes bleed to the rail walls
    // and re-inset to `--sidebar-lane-inset`, while the masthead chrome
    // (pills + lens switch) pulls out from the wider `--sidebar-rail-inset`
    // to the same lane edge via the derived `--sidebar-masthead-pull`. The
    // tabs/pills once sat at the rail inset while the cards sat narrower, so
    // they read as misaligned; the Directories lane separately drifted to a
    // 4px left gutter while the Recents lane was at 8px. Both classes of
    // drift were silent because no test pinned the relationship — so pin it
    // here by asserting every consumer reads the shared tokens, not a
    // hand-tuned literal.
    const sidebarBody = extractRuleBody(css, ".sidebar");
    expect(sidebarBody).toMatch(/--sidebar-rail-inset:\s*16px;/);
    expect(sidebarBody).toMatch(/--sidebar-lane-inset:\s*8px;/);
    // The masthead pull is always derived from the two insets, never set
    // by hand — that's what keeps the chrome glued to the lane edge.
    expect(sidebarBody).toMatch(
      /--sidebar-masthead-pull:\s*calc\(\s*var\(--sidebar-lane-inset\)\s*-\s*var\(--sidebar-rail-inset\)\s*\)/
    );

    // Both lanes inset to the same lane token (no recurrence of the
    // 4px-left / 8px-left split between Directories and Recents). Each
    // selector has more than one base rule (a layout rule plus the scroll
    // rule), so collect every body and assert the inset lives in one of
    // them — mirroring the scrollbar guard above.
    for (const selector of [".sidebar-list--dense", ".directory-groups"]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bodies = [
        ...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g")),
      ].map((match) => match[1]);
      expect(
        bodies.some((body) =>
          /padding-inline:\s*var\(--sidebar-lane-inset\);/.test(body)
        )
      ).toBe(true);
    }

    // Both masthead rows pull out to the lane edge via the shared token.
    for (const selector of [".runtime-identity", ".lens-switch"]) {
      expect(extractRuleBody(css, selector)).toMatch(
        /margin-inline:\s*var\(--sidebar-masthead-pull\)/
      );
    }
    // The lens switch is an inline-grid that can't stretch, so it also
    // grows its explicit width by twice the pull to reach both lane edges.
    expect(extractRuleBody(css, ".lens-switch")).toMatch(
      /width:\s*calc\(\s*100%\s*-\s*2\s*\*\s*var\(--sidebar-masthead-pull\)\s*\)/
    );

    // The scroll region cancels exactly the rail padding to bleed to the
    // walls — kept in lockstep with the padding via the same token.
    expect(extractRuleBody(css, ".sidebar__scroll-region")).toMatch(
      /margin-inline:\s*calc\(\s*-1\s*\*\s*var\(--sidebar-rail-inset\)\s*\)/
    );
  });

  it("applies a thin, themed scrollbar to every scroller via the universal selector (scrollbar-width does not inherit)", () => {
    // `scrollbar-color` inherits but `scrollbar-width` does NOT, so a
    // `:root` rule alone leaves scrollers at the chunky default width in
    // classic mode (only tinted). The universal selector sets the thin
    // width on every element so all scroll containers (transcript,
    // settings, …) actually render thin.
    const universal = extractRuleBody(css, "*");
    expect(universal).toContain("scrollbar-width: thin;");
    expect(universal).toContain(
      "scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);"
    );
  });

  it("keeps the PR chip and its hover card on one set of dot-color rules", () => {
    // The card's dot must never disagree with the chip that opened it, so the
    // two share declarations rather than each naming tokens. Restating a color
    // in a card-only rule is how they drift; this fails if anyone does.
    for (const [chipSelector, cardSelector] of [
      [".pr-chip--passing .pr-chip__dot", ".pr-status-card .pr-status-card__dot--passing"],
      [".pr-chip--failing .pr-chip__dot", ".pr-status-card .pr-status-card__dot--failing"],
      [".pr-chip--pending .pr-chip__dot", ".pr-status-card .pr-status-card__dot--pending"],
      [".pr-chip--merged .pr-chip__dot", ".pr-status-card .pr-status-card__dot--merged"],
      [".pr-chip--closed .pr-chip__dot", ".pr-status-card .pr-status-card__dot--closed"],
      [
        ".pr-chip.pr-chip--conflicting .pr-chip__dot",
        ".pr-status-card .pr-status-card__dot--conflicting",
      ],
    ]) {
      const escaped = chipSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(css).toMatch(
        new RegExp(`${escaped},\\s*\\n${cardSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`)
      );
    }

    // The card's dot modifiers carry an extra `.pr-status-card` qualifier so
    // they outrank `.pr-status-card__dot`'s default gray, which is declared
    // later in the file. Drop the qualifier and every dot goes gray.
    expect(css).not.toMatch(/\n\.pr-status-card__dot--\w+\s*[,{]/);
  });

  it("layers the PR hover card above the Star Map window root", () => {
    // PR chips render on cards inside `.star-map-window`, whose stacking
    // context scopes the card z-scale — the portal only has to beat the
    // window root's own z-index, not the cards inside it.
    const windowRule = extractRuleBody(css, ".star-map-window");
    const card = extractRuleBody(css, ".pr-status-card");
    const windowZ = Number(windowRule.match(/z-index:\s*(\d+);/)?.[1]);
    const cardZ = Number(card.match(/z-index:\s*(\d+);/)?.[1]);
    expect(Number.isFinite(windowZ)).toBe(true);
    expect(cardZ).toBeGreaterThan(windowZ);
  });

  it("keeps thinking scanner variants on one shared visible sweep", () => {
    expect(css).not.toContain("--thinking-scanner-progress");
    expect(css).not.toContain("--thinking-scanner-full-offset");
    expect(css).not.toContain("--thinking-scanner-mini-offset");
    expect(css).toContain("@keyframes pwragent-thinking-scanner-sweep");
    // Read the blocks out by selector rather than matching declarations
    // anywhere after the first `.thinking-scanner {` in the file. A descendant
    // rule that retints the scanner (`.signal-count--remote-active
    // .thinking-scanner`) ends with the same three characters, so an
    // unanchored pattern starts THERE and lazily bridges thousands of lines to
    // collect these declarations from wherever they happen to live — which
    // would let the geometry drift out of the base block with the test still
    // green. `extractRuleBody` anchors on a line start and stops at the
    // block's own closing brace.
    const scanner = extractRuleBody(css, ".thinking-scanner");
    expect(scanner).toMatch(/--thinking-scanner-beam-width:\s*18px;/);
    expect(scanner).toMatch(/--thinking-scanner-travel:\s*44px;/);
    expect(scanner).toMatch(/width:\s*62px;/);
    const miniScanner = extractRuleBody(css, ".thinking-scanner--mini");
    expect(miniScanner).toMatch(/--thinking-scanner-beam-width:\s*6px;/);
    expect(miniScanner).toMatch(/--thinking-scanner-travel:\s*10px;/);
    expect(miniScanner).toMatch(/width:\s*16px;/);
    expect(extractRuleBody(css, ".thinking-scanner__beam")).toMatch(
      /animation:\s*pwragent-thinking-scanner-sweep 1800ms ease-in-out infinite;/
    );
  });

  it("keeps every composer autocomplete on the shared popover highlight", () => {
    // The `$` / `/` / `@` / `#` pickers are four render branches of one
    // control, and they drifted into two different selection languages:
    // `@` tinted with --accent-soft (matching `.reference-picker__row`,
    // `.project-picker__row`, and `.branch-picker__option`) while the
    // other three drew the thread-row treatment — an --accent-border
    // outline, a --bg-row-active fill, AND a 3px --accent ::before bar.
    // That put three separate tangerines on one row and made the same
    // gesture look like two different things.
    //
    // The tint is the popover language; the bar + border + row-active
    // fill stays reserved for `.thread-row.is-selected`, which marks a
    // persistent selection rather than a transient "Enter lands here".
    const sharedHighlight = css.match(
      /\.composer__autocomplete-option:hover:not\(:disabled\),\s*\.composer__autocomplete-option\.is-active\s*\{(?<body>[^}]*)\}/
    )?.groups?.body;
    expect(sharedHighlight).toBeTruthy();
    expect(sharedHighlight).toContain("background: var(--accent-soft);");
    expect(sharedHighlight).toContain("color: var(--accent-bright);");
    // No per-picker override may reintroduce a second highlight: not the
    // accent bar, and not the thread-row fill/outline pair.
    expect(css).not.toMatch(
      /\.composer__autocomplete-option(?:[^{]*)\.is-active(?:[^{]*)::before\s*\{/
    );
    expect(sharedHighlight).not.toContain("var(--bg-row-active)");
    expect(sharedHighlight).not.toContain("var(--accent-border)");
  });

  it("does not let a disabled autocomplete row hover into the accent tint", () => {
    // `.composer__autocomplete-option:disabled` sits ~1200 lines earlier
    // with identical specificity, so it loses on source order. Without
    // the guard, hovering a disabled row (the remote-federation "Add
    // directory… / Add file…" actions) paints it in full accent and
    // overrides its muted disabled color — the row looks live. The
    // sibling pickers guard the same way.
    expect(css).toContain(
      ".composer__autocomplete-option:hover:not(:disabled),",
    );
    expect(css).not.toMatch(
      /^\.composer__autocomplete-option:hover\s*[,{]/m
    );
  });

  it("keeps the autocomplete typed-run highlight legible on the tinted row", () => {
    // On the hovered/active row the whole label is already
    // --accent-bright, so a color-only match highlight disappears on
    // precisely the row the operator is reading. Weight carries it in
    // both states; color alone is not enough.
    const matchRule = extractRuleBody(css, ".composer__autocomplete-match");
    expect(matchRule).toContain("color: var(--accent-bright);");
    expect(matchRule).toMatch(/font-weight:\s*700;/);
  });

  it("spends no accent on autocomplete row badges or kind icons", () => {
    // Per UI-THEME.md's accent-ramp rule: a row carries the selection
    // tint and the typed run, and nothing else. Badges are metadata and
    // rank via neutrals; kind icons stay muted through hover so the row
    // reads as one signal instead of lighting up every glyph.
    const pwragentBadge = extractRuleBody(
      css,
      ".composer__autocomplete-source--pwragent",
    );
    expect(pwragentBadge).not.toMatch(/var\(--accent/);
    expect(pwragentBadge).toContain("border-color: var(--border-strong);");

    const kindIcon = extractRuleBody(css, ".composer__autocomplete-title > svg");
    expect(kindIcon).toContain("color: var(--text-muted);");

    // The `/` picker used to draw an --accent-border box containing a
    // literal "/" immediately before a label that already read
    // "/review". It duplicated the sigil and spent a third tangerine to
    // do it.
    expect(css).not.toContain(".composer__autocomplete-token");
  });
});
