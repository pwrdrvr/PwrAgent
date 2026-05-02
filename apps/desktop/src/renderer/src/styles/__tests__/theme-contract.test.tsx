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
    expect(css).toMatch(
      /\.transcript-list__items\s*\{[\s\S]*?padding-bottom:\s*24px;[\s\S]*?\}/
    );
    expect(css).toMatch(
      /\.transcript-list__items:has\(\.transcript-list__pending:last-child\)\s*\{[\s\S]*?padding-bottom:\s*4px;[\s\S]*?\}/
    );
    expect(css).not.toMatch(
      /\.transcript-list__items\s*\{[\s\S]*?padding-bottom:\s*(?:[4-9]\d|\d{3,})px;[\s\S]*?\}/
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

  it("keeps composer autocomplete visually separated from transcript surfaces", () => {
    const autocompleteRule = extractRuleBody(css, ".composer__autocomplete");

    expect(autocompleteRule).toContain("border: 1px solid var(--border-strong);");
    expect(autocompleteRule).toContain("background: var(--bg-panel-elevated);");
    expect(autocompleteRule).toContain("inset 0 0 0 1px rgba(247, 243, 235, 0.06)");
    expect(autocompleteRule).not.toContain("background: rgba(10, 10, 10, 0.98);");
  });

  it("keeps thinking scanner variants on one shared visible sweep", () => {
    expect(css).toContain("--thinking-scanner-progress: 0;");
    expect(css).toContain("--thinking-scanner-full-offset: 0px;");
    expect(css).toContain("--thinking-scanner-mini-offset: 0px;");
    expect(css).not.toContain("@keyframes pwragnt-kitt-scan");
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
