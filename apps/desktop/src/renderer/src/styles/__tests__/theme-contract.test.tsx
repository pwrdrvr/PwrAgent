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

  it("keeps unavailable thread detail surfaces draggable", () => {
    const emptyStateRule = extractRuleBody(css, ".thread-empty-state");
    const pendingMainRule = extractRuleBody(css, ".app-main--thread-detail-pending");

    expect(emptyStateRule).toContain("padding: 0 16px;");
    expect(emptyStateRule).toContain("flex: 1;");
    expect(emptyStateRule).toContain("min-height: 0;");
    expect(emptyStateRule).toContain("-webkit-app-region: drag;");
    expect(pendingMainRule).toContain("-webkit-app-region: drag;");
    expect(css).toMatch(
      /\.thread-empty-state \*\s*\{[\s\S]*?-webkit-app-region:\s*drag;[\s\S]*?\}/
    );
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

  it("keeps launchpad header chips content-sized and aligned with the eyebrow", () => {
    const launchpadHeaderRule = extractRuleBody(css, ".thread-header--launchpad");
    const launchpadAsideRule = extractRuleBody(css, ".thread-header__launchpad-aside");
    const eyebrowRule = extractRuleBody(css, ".thread-header__eyebrow-row > .eyebrow");

    expect(launchpadHeaderRule).toContain("align-items: flex-start;");
    expect(launchpadAsideRule).toContain("align-items: flex-start;");
    expect(eyebrowRule).toContain("height: 24px;");
    expect(eyebrowRule).toContain("margin: 0 2px 0 0;");
    expect(css).toMatch(
      /\.thread-header--launchpad \.thread-header__eyebrow-row > \.thread-row__chip\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?\}/
    );
    expect(css).toMatch(
      /\.thread-header--launchpad \.messaging-status-bar\s*\{[\s\S]*?padding-top:\s*0;[\s\S]*?padding-bottom:\s*0;[\s\S]*?\}/
    );
  });

  it("keeps launchpad setup output from shrinking the header summary", () => {
    const setupComposerRule = extractRuleBody(
      css,
      ".thread-view__launchpad-composer:has(.transcript-panel--setup)"
    );

    expect(css).toMatch(
      /\.thread-view--launchpad > \.thread-header,\s*\.thread-view--launchpad > \.launchpad-panel\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?\}/
    );
    expect(setupComposerRule).toContain("flex: 1 1 0;");
    expect(setupComposerRule).toContain("min-height: 0;");
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
    expect(css).toMatch(
      /\.thread-row-shell:hover \.thread-row__time,\s*\.thread-row-shell:has\(\.thread-row__overflow-button:focus-visible\) \.thread-row__time,\s*\.thread-row-shell:has\(\.thread-row__chip--add-reaction:focus-visible\) \.thread-row__time,\s*\.thread-row-shell:has\(\.thread-row__chip--add-reaction\.is-open\) \.thread-row__time\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?\}/
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

    expect(autocompleteRule).toContain("border: 1px solid var(--border-strong);");
    expect(autocompleteRule).toContain("background: var(--bg-panel-elevated);");
    expect(autocompleteRule).toContain(
      "inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 6%, transparent)",
    );
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
    expect(css).toMatch(
      /:root\[data-platform\]:not\(\[data-platform="darwin"\]\):not\(\[data-platform="win32"\]\)\s*\.sidebar__masthead\s*\{[\s\S]*?padding-left:\s*0;[\s\S]*?\}/,
    );
    expect(css).toMatch(
      /:root\[data-platform\]:not\(\[data-platform="darwin"\]\):not\(\[data-platform="win32"\]\)\s*\.settings-nav__masthead\s*\{[\s\S]*?padding-left:\s*0;[\s\S]*?\}/,
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
