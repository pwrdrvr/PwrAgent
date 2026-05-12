import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(testDir, "../app.css");
const css = readFileSync(cssPath, "utf8");

function extractRootTokens(source: string): Record<string, string> {
  const rootMatch = source.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/);
  if (!rootMatch?.groups?.body) {
    throw new Error("Expected app.css to define a :root token block");
  }

  return Object.fromEntries(
    [...rootMatch.groups.body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()]
    )
  );
}

/**
 * Pulls the body out of the FIRST CSS rule whose selector matches.
 *
 * Caveat: if `app.css` ever wraps a selector in a `@media` (or `@supports`)
 * block at the top level, this picks the outermost `{ ... \n}` it sees,
 * which may not be the rule the test intended. Today every selector in
 * `app.css` is defined exactly once at the top level, so the first match
 * IS the right one. If that ever changes, scope the regex by the
 * surrounding `@media` boundary first.
 */
function extractRuleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = source.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`));
  if (!ruleMatch?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }

  return ruleMatch.groups.body;
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

  it("defines the semantic tokens used by the renderer theme", () => {
    expect(tokens).toMatchObject({
      "accent": "#ff8a1f",
      "accent-border": "rgba(255, 138, 31, 0.42)",
      "accent-bright": "#ffb35c",
      "accent-soft": "rgba(255, 138, 31, 0.12)",
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
    ];

    for (const [foreground, background, threshold] of pairs) {
      expect(
        contrastRatio(tokens[foreground], tokens[background]),
        `${foreground} on ${background}`
      ).toBeGreaterThanOrEqual(threshold);
    }
  });

  it("does not leave unresolved theme token references in app.css", () => {
    const tokenReferences = [...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map(
      ([, token]) => token
    );
    const missingTokens = tokenReferences.filter((token) => !tokens[token]);

    expect([...new Set(missingTokens)]).toEqual([]);
  });

  it("removes the previous chartreuse accent literals from app.css", () => {
    expect(css).not.toContain("#b8ff4d");
    expect(css).not.toContain("184, 255, 77");
    expect(css).not.toContain("168, 255, 63");
  });

  it("keeps transcript bottom reserve close to the thinking indicator height", () => {
    // The items rule may declare bottom padding either explicitly
    // (`padding-bottom: 24px`) or via the `padding` shorthand
    // (`padding: T R 24px L`). Both are equivalent; the lock here is
    // that the bottom value stays at 24 (the over-scroll feel above
    // the last message / thinking indicator) and that the pending
    // override still drops to 4px.
    const itemsRule = css.match(/\.transcript-list__items\s*\{[\s\S]*?\}/)?.[0];
    expect(itemsRule).toBeDefined();
    expect(itemsRule).toMatch(
      /padding-bottom:\s*24px;|padding:\s*\S+\s+\S+\s+24px(?:\s+\S+)?;/,
    );
    expect(css).toMatch(
      /\.transcript-list__items:has\(\.transcript-list__pending:last-child\)\s*\{[\s\S]*?padding-bottom:\s*4px;[\s\S]*?\}/
    );
    // Negative regex stays — guard against accidental large bottom
    // values (>= 40px) regardless of which form is used.
    expect(itemsRule).not.toMatch(
      /padding-bottom:\s*(?:[4-9]\d|\d{3,})px;|padding:\s*\S+\s+\S+\s+(?:[4-9]\d|\d{3,})px(?:\s+\S+)?;/,
    );
  });

  it("keeps the startup thread detail empty state off the sidebar edge", () => {
    const emptyStateRule = extractRuleBody(css, ".thread-empty-state");

    expect(emptyStateRule).toContain("padding: 0 16px;");
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

  it("keeps messaging indicators ahead of thread header title overflow", () => {
    const headerMainRule = extractRuleBody(css, ".thread-header__main");
    const statusBarRule = extractRuleBody(css, ".messaging-status-bar");
    const eyebrowRowRule = extractRuleBody(css, ".thread-header__eyebrow-row");
    const compactTitleRule = extractRuleBody(css, ".thread-header__compact-title");

    expect(headerMainRule).toContain("flex: 1 1 0;");
    expect(statusBarRule).toContain("flex: 0 0 auto;");
    expect(statusBarRule).toContain("min-width: max-content;");
    expect(eyebrowRowRule).toContain("min-width: 0;");
    expect(compactTitleRule).toContain("flex: 1 1 auto;");
    expect(compactTitleRule).toContain("overflow: hidden;");
    expect(css).toMatch(
      /\.thread-header__eyebrow-row > \.thread-row__chip\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?\}/
    );
  });

  it("reserves opened context rail width for the thread header status area", () => {
    expect(css).toMatch(
      /\.thread-view:has\(\.context-rail\.is-open\) \.thread-header\s*\{[\s\S]*?padding-right:\s*calc\(min\(var\(--context-rail-width, 380px\), calc\(100% - 32px\)\) \+ 12px\);[\s\S]*?\}/
    );
    expect(css).toMatch(
      /\.thread-view:has\(\.context-rail\.is-pinned\) \.thread-header,\s*\.thread-view:has\(\.thread-view__layout\.has-pinned-context-rail\) \.thread-header\s*\{[\s\S]*?padding-right:\s*calc\(min\(var\(--context-rail-width, 380px\), 42vw\) \+ 12px\);[\s\S]*?\}/
    );
    expect(css).toMatch(
      /@media \(max-width: 1100px\)\s*\{[\s\S]*?\.thread-view:has\(\.context-rail\.is-open\) \.thread-header,[\s\S]*?padding-right:\s*56px;[\s\S]*?\}/
    );
    expect(css).not.toContain("the header reclaims the space");
  });

  it("keeps composer autocomplete visually separated from transcript surfaces", () => {
    const autocompleteRule = extractRuleBody(css, ".composer__autocomplete");

    expect(autocompleteRule).toContain("border: 1px solid var(--border-strong);");
    expect(autocompleteRule).toContain("background: var(--bg-panel-elevated);");
    expect(autocompleteRule).toContain("inset 0 0 0 1px rgba(247, 243, 235, 0.06)");
    expect(autocompleteRule).not.toContain("background: rgba(10, 10, 10, 0.98);");
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
    const tiptapRule = extractRuleBody(css, ".composer-tiptap-input");
    expect(tiptapRule).toMatch(/min-height:\s*56px;/);
    expect(tiptapRule).toMatch(/max-height:\s*280px;/);
    expect(tiptapRule).toMatch(/overflow-y:\s*auto;/);

    // The inner editor's min-height tracks the outer container's
    // (-2 for the 1px border on each side of the wrapper) so the
    // editor visually fills the wrapper at the empty-state floor.
    const editorRule = extractRuleBody(css, ".composer-tiptap-input__editor");
    expect(editorRule).toMatch(/min-height:\s*54px;/);

    // The unused-but-styled `<textarea>` variant (`.composer__input`)
    // shares the same empty-state floor so a future swap to it
    // doesn't surprise the reading area.
    const textareaRule = extractRuleBody(css, ".composer__input");
    expect(textareaRule).toMatch(/min-height:\s*56px;/);
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

  it("keeps thinking scanner variants on one shared visible sweep", () => {
    expect(css).toContain("--thinking-scanner-progress: 0;");
    expect(css).toContain("--thinking-scanner-full-offset: 0px;");
    expect(css).toContain("--thinking-scanner-mini-offset: 0px;");
    expect(css).not.toContain("@keyframes pwragent-kitt-scan");
    expect(css).toMatch(
      /\.thinking-scanner\s*\{[\s\S]*?--thinking-scanner-beam-width:\s*18px;[\s\S]*?--thinking-scanner-offset:\s*var\(--thinking-scanner-full-offset\);[\s\S]*?width:\s*62px;[\s\S]*?\}/
    );
    expect(css).toMatch(
      /\.thinking-scanner--mini\s*\{[\s\S]*?--thinking-scanner-beam-width:\s*6px;[\s\S]*?--thinking-scanner-offset:\s*var\(--thinking-scanner-mini-offset\);[\s\S]*?width:\s*16px;[\s\S]*?\}/
    );
    expect(css).toMatch(
      /\.thinking-scanner__beam\s*\{[\s\S]*?transform:\s*translateX\(var\(--thinking-scanner-offset\)\);[\s\S]*?\}/
    );
  });
});
