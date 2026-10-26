import { afterEach, describe, expect, it } from "vitest";
import { cssWithOnlyProperties } from "./css-property-cascade";

const squash = (css: string) => css.replace(/\s+/g, " ").trim();

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("cssWithOnlyProperties", () => {
  it("keeps the named declarations and drops rules left empty", () => {
    const css = `
      .panel { position: fixed; z-index: 135; color: red; }
      .label { color: blue; }
      .card { Z-Index: 4 !important; }
    `;
    expect(squash(cssWithOnlyProperties(css, ["z-index"]))).toBe(
      ".panel { z-index: 135; } .card { Z-Index: 4 !important; }",
    );
  });

  it("keeps conditional wrappers and drops at-rules that style no element", () => {
    const css = `
      @import "./fonts.css";
      @font-face { font-family: Sample; src: url(sample.woff2); }
      @keyframes rise { from { z-index: 1; } to { z-index: 2; } }
      @media (min-width: 600px) { .panel { z-index: 3; width: 10px; } .label { color: red; } }
      @supports (display: grid) { .label { color: red; } }
      @layer base, overrides;
      @layer base { .label { color: red; } }
    `;
    expect(squash(cssWithOnlyProperties(css, ["z-index"]))).toBe(
      "@media (min-width: 600px) { .panel { z-index: 3; } } @layer base, overrides; @layer base { }",
    );
  });

  it("does not split on punctuation inside strings, comments and url()", () => {
    const css = `
      .icon { background: url(data:image/svg+xml;utf8,<svg>{}</svg>); z-index: 1; }
      .quote::before { content: "};{"; z-index: 2; }
      /* .ghost { z-index: 9; } */
      .after { z-index: 3; }
    `;
    expect(squash(cssWithOnlyProperties(css, ["z-index"]))).toBe(
      ".icon { z-index: 1; } .quote::before { z-index: 2; } .after { z-index: 3; }",
    );
  });

  it("keeps `all` and every custom property a kept value reads", () => {
    const css = `
      :root { --layer-base: 100; --layer-panel: calc(var(--layer-base) + 35); --Accent: red; --unused: 1; }
      .panel { z-index: var(--layer-panel); }
      .reset { all: unset; color: var(--Accent); }
    `;
    expect(squash(cssWithOnlyProperties(css, ["z-index"]))).toBe(
      ":root { --layer-base: 100; --layer-panel: calc(var(--layer-base) + 35); }"
      + " .panel { z-index: var(--layer-panel); } .reset { all: unset; }",
    );
  });

  it("resolves the same computed value as the full sheet", () => {
    const css = `
      .layer { z-index: 10; color: red; display: block; }
      .shell .layer { padding: 4px; }
      #top.layer { z-index: 30; margin: 0; }
      .layer.raised { z-index: 20 !important; }
      .later { z-index: 40; }
      .later { z-index: 50; }
    `;
    document.body.innerHTML = `
      <div class="shell">
        <span class="layer"></span>
        <span id="top" class="layer"></span>
        <span class="layer raised"></span>
        <span class="later"></span>
      </div>
    `;
    const zIndexes = (sheet: string) => {
      const style = document.createElement("style");
      style.textContent = sheet;
      document.head.append(style);
      const values = [...document.querySelectorAll(".shell > *")].map((element) => getComputedStyle(element).zIndex);
      style.remove();
      return values;
    };
    expect(zIndexes(cssWithOnlyProperties(css, ["z-index"]))).toEqual(zIndexes(css));
    expect(zIndexes(css)).toEqual(["10", "30", "20", "50"]);
  });
});
