import { describe, expect, it } from "vitest";
import {
  MESSAGING_COMMAND_CATALOG,
  formatMessagingCommandHelpBody,
  matchMessagingCommandVerb,
} from "../messaging/core/messaging-command-catalog.js";

describe("MESSAGING_COMMAND_CATALOG", () => {
  it("declares the canonical verb set in the documented order", () => {
    // Order is intentional — `resume` is the most common entry
    // point, `help` is the meta-command. The `/help` body relies on
    // this order; if you reorder, the help text reorders too.
    expect(MESSAGING_COMMAND_CATALOG.map((spec) => spec.verb)).toEqual([
      "resume",
      "status",
      "detach",
      "help",
    ]);
  });

  it("provides a non-empty description for every verb", () => {
    for (const spec of MESSAGING_COMMAND_CATALOG) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("uses lowercase verbs (matches dispatch contract — controller lowercases inbound commands before lookup)", () => {
    for (const spec of MESSAGING_COMMAND_CATALOG) {
      expect(spec.verb).toBe(spec.verb.toLowerCase());
    }
  });
});

describe("matchMessagingCommandVerb", () => {
  it("recognizes every catalog verb", () => {
    for (const spec of MESSAGING_COMMAND_CATALOG) {
      expect(matchMessagingCommandVerb(spec.verb)).toBe(spec.verb);
    }
  });

  it("strips a leading slash before matching", () => {
    expect(matchMessagingCommandVerb("/resume")).toBe("resume");
    expect(matchMessagingCommandVerb("/status")).toBe("status");
  });

  it("is case-insensitive", () => {
    expect(matchMessagingCommandVerb("RESUME")).toBe("resume");
    expect(matchMessagingCommandVerb("/Status")).toBe("status");
    expect(matchMessagingCommandVerb("HELP")).toBe("help");
  });

  it("trims surrounding whitespace", () => {
    expect(matchMessagingCommandVerb("  resume  ")).toBe("resume");
    expect(matchMessagingCommandVerb("  /status  ")).toBe("status");
  });

  it("returns undefined for unknown commands (controller falls through to help)", () => {
    expect(matchMessagingCommandVerb("threads")).toBeUndefined();
    expect(matchMessagingCommandVerb("/quit")).toBeUndefined();
    expect(matchMessagingCommandVerb("foo bar")).toBeUndefined();
  });

  it("returns undefined for empty / whitespace / slash-only input", () => {
    expect(matchMessagingCommandVerb("")).toBeUndefined();
    expect(matchMessagingCommandVerb("   ")).toBeUndefined();
    expect(matchMessagingCommandVerb("/")).toBeUndefined();
    expect(matchMessagingCommandVerb("//")).toBeUndefined();
  });
});

describe("formatMessagingCommandHelpBody", () => {
  it("renders one bullet per catalog entry, in catalog order", () => {
    const body = formatMessagingCommandHelpBody();
    const expectedBullets = MESSAGING_COMMAND_CATALOG.map(
      (spec) => `• \`${spec.verb}\` — ${spec.description}`,
    );
    for (const expected of expectedBullets) {
      expect(body).toContain(expected);
    }
    // Order check: resume must come before status, status before
    // detach, etc. — catalog order is the contract.
    const resumeIdx = body.indexOf("`resume`");
    const statusIdx = body.indexOf("`status`");
    const detachIdx = body.indexOf("`detach`");
    const helpIdx = body.indexOf("`help`");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(resumeIdx);
    expect(detachIdx).toBeGreaterThan(statusIdx);
    expect(helpIdx).toBeGreaterThan(detachIdx);
  });

  it("appends the default invocation footer with both styles", () => {
    const body = formatMessagingCommandHelpBody();
    expect(body).toContain("/<cmd>");
    expect(body).toContain("@<bot>");
  });

  it("accepts a custom invocation footer (provider-specific overrides)", () => {
    const body = formatMessagingCommandHelpBody({
      invocationFooter: "Type `/pwragent_resume` or `@pwragent resume`.",
    });
    expect(body).toContain("Type `/pwragent_resume`");
    // Default footer should NOT appear when caller supplied one.
    expect(body).not.toContain("/<cmd>");
  });

  it("accepts a custom catalog (e.g., a subset for a constrained surface)", () => {
    const subset = MESSAGING_COMMAND_CATALOG.filter(
      (spec) => spec.verb === "resume" || spec.verb === "help",
    );
    const body = formatMessagingCommandHelpBody({ catalog: subset });
    expect(body).toContain("`resume`");
    expect(body).toContain("`help`");
    expect(body).not.toContain("`status`");
    expect(body).not.toContain("`detach`");
  });

  it("separates the bullet list from the footer with a blank line", () => {
    const body = formatMessagingCommandHelpBody();
    // Last bullet should be followed by an empty line, then the footer.
    const lastBulletIdx = body.lastIndexOf("•");
    const footerIdx = body.indexOf("Invoke");
    expect(footerIdx).toBeGreaterThan(lastBulletIdx);
    // Between them: at least one blank line.
    const between = body.slice(lastBulletIdx, footerIdx);
    expect(between).toMatch(/\n\n/);
  });
});
