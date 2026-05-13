import { describe, expect, it } from "vitest";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  buildHelpActions,
  formatMessagingCommandHelpBody,
  helpPageSize,
  matchMessagingCommandVerb,
  MESSAGING_COMMAND_CATALOG,
  paginateHelpCatalog,
  type MessagingCommandSpec,
} from "../messaging/core/messaging-command-catalog.js";

describe("MESSAGING_COMMAND_CATALOG", () => {
  it("declares the canonical verb set in the documented order", () => {
    // Order is intentional — `resume` is the most common entry
    // point, `help` is the meta-command. The `/help` body relies on
    // this order; if you reorder, the help text reorders too.
    expect(MESSAGING_COMMAND_CATALOG.map((spec) => spec.verb)).toEqual([
      "resume",
      "new",
      "status",
      "detach",
      "monitor",
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
    expect(matchMessagingCommandVerb("/new")).toBe("new");
    expect(matchMessagingCommandVerb("/status")).toBe("status");
    expect(matchMessagingCommandVerb("/monitor")).toBe("monitor");
  });

  it("is case-insensitive", () => {
    expect(matchMessagingCommandVerb("RESUME")).toBe("resume");
    expect(matchMessagingCommandVerb("/Status")).toBe("status");
    expect(matchMessagingCommandVerb("/MONITOR")).toBe("monitor");
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
  it("renders one plain command line per catalog entry, in catalog order", () => {
    const body = formatMessagingCommandHelpBody();
    const expectedLines = MESSAGING_COMMAND_CATALOG.map(
      (spec) => `/${spec.verb} - ${spec.description}`,
    );
    for (const expected of expectedLines) {
      expect(body).toContain(expected);
    }
    // Order check: resume must come before status, status before
    // detach, etc. — catalog order is the contract.
    const resumeIdx = body.indexOf("/resume");
    const newIdx = body.indexOf("/new");
    const statusIdx = body.indexOf("/status");
    const detachIdx = body.indexOf("/detach");
    const monitorIdx = body.indexOf("/monitor");
    const helpIdx = body.indexOf("/help");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThan(resumeIdx);
    expect(statusIdx).toBeGreaterThan(newIdx);
    expect(detachIdx).toBeGreaterThan(statusIdx);
    expect(monitorIdx).toBeGreaterThan(detachIdx);
    expect(helpIdx).toBeGreaterThan(monitorIdx);
  });

  it("appends the default invocation footer with both styles", () => {
    const body = formatMessagingCommandHelpBody();
    expect(body).toContain("Send a command or tap a button.");
    expect(body).toContain("@bot new");
  });

  it("accepts a custom invocation footer (provider-specific overrides)", () => {
    const body = formatMessagingCommandHelpBody({
      invocationFooter: "Type /pwragent_resume or @pwragent resume.",
    });
    expect(body).toContain("Type /pwragent_resume");
    // Default footer should NOT appear when caller supplied one.
    expect(body).not.toContain("@bot new");
  });

  it("accepts a custom catalog (e.g., a subset for a constrained surface)", () => {
    const subset = MESSAGING_COMMAND_CATALOG.filter(
      (spec) => spec.verb === "resume" || spec.verb === "help",
    );
    const body = formatMessagingCommandHelpBody({ catalog: subset });
    expect(body).toContain("/resume");
    expect(body).toContain("/help");
    expect(body).not.toContain("/new");
    expect(body).not.toContain("/status");
    expect(body).not.toContain("/detach");
  });

  it("separates the command list from the footer with a blank line", () => {
    const body = formatMessagingCommandHelpBody();
    const lastCommandIdx = body.lastIndexOf("/help");
    const footerIdx = body.indexOf("You can also");
    expect(footerIdx).toBeGreaterThan(lastCommandIdx);
    // Between them: at least one blank line.
    const between = body.slice(lastCommandIdx, footerIdx);
    expect(between).toMatch(/\n\n/);
  });
});

// Capability-profile fixtures for pagination tests. Override the
// permissive profile's `actions.maxActions` to exercise the
// page-size math; everything else stays at the test-friendly
// defaults. The `!` is safe — `PERMISSIVE_CAPABILITY_PROFILE.actions`
// is statically known to be defined (the permissive profile's whole
// purpose is to declare every field), but the type marks it
// optional because the production profile shape allows omission.
function profileWithMaxActions(maxActions: number): MessagingCapabilityProfile {
  return {
    ...PERMISSIVE_CAPABILITY_PROFILE,
    actions: {
      ...PERMISSIVE_CAPABILITY_PROFILE.actions!,
      maxActions,
    },
  };
}

// Synthetic catalog used to exercise multi-page rendering without
// touching the canonical catalog. 12 entries × 8 page-size cap →
// two pages.
function syntheticCatalog(count: number): MessagingCommandSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    // The catalog type expects the canonical verb union. Cast
    // through `unknown` because synthetic verbs only exist in
    // tests; the catalog never exposes these names at runtime.
    verb: (`v${i}` as unknown) as MessagingCommandSpec["verb"],
    description: `synthetic verb ${i}`,
  }));
}

describe("helpPageSize", () => {
  it("returns the soft cap (8) when no profile is provided", () => {
    expect(helpPageSize(undefined)).toBe(8);
  });

  it("returns the soft cap when the profile's action budget is generous", () => {
    expect(helpPageSize(profileWithMaxActions(25))).toBe(8);
  });

  it("clamps to the available budget when the profile is constrained", () => {
    // 5 maxActions − 3 nav reservation = 2 command buttons / page.
    expect(helpPageSize(profileWithMaxActions(5))).toBe(2);
  });

  it("returns 0 when the profile has fewer slots than the nav budget", () => {
    // 2 maxActions − 3 nav reservation = -1 → 0 (text-only fallback).
    expect(helpPageSize(profileWithMaxActions(2))).toBe(0);
  });
});

describe("paginateHelpCatalog", () => {
  it("returns a single page with every catalog entry when the profile fits all", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(25),
    });
    expect(page.totalPages).toBe(1);
    expect(page.pageIndex).toBe(0);
    expect(page.commands.map((c) => c.verb)).toEqual([
      "resume",
      "new",
      "status",
      "detach",
      "monitor",
      "help",
    ]);
  });

  it("paginates correctly when the catalog overflows page size", () => {
    const synthetic = syntheticCatalog(12);
    const profile = profileWithMaxActions(25); // 8-cap → page size 8
    const first = paginateHelpCatalog({
      catalog: synthetic,
      profile,
      pageIndex: 0,
    });
    expect(first.totalPages).toBe(2);
    expect(first.commands).toHaveLength(8);
    expect(first.commands[0].verb).toBe("v0");
    expect(first.commands[7].verb).toBe("v7");

    const second = paginateHelpCatalog({
      catalog: synthetic,
      profile,
      pageIndex: 1,
    });
    expect(second.commands).toHaveLength(4);
    expect(second.commands[0].verb).toBe("v8");
    expect(second.commands[3].verb).toBe("v11");
  });

  it("clamps pageIndex past the last page back to the last page", () => {
    const synthetic = syntheticCatalog(12);
    const page = paginateHelpCatalog({
      catalog: synthetic,
      profile: profileWithMaxActions(25),
      pageIndex: 99,
    });
    // Last page is index 1 (totalPages = 2).
    expect(page.pageIndex).toBe(1);
    expect(page.commands[0].verb).toBe("v8");
  });

  it("clamps negative pageIndex to 0", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(25),
      pageIndex: -5,
    });
    expect(page.pageIndex).toBe(0);
  });

  it("returns an empty page when the profile is too constrained to render any buttons", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(2),
    });
    expect(page.pageSize).toBe(0);
    expect(page.totalPages).toBe(0);
    expect(page.commands).toHaveLength(0);
  });
});

describe("buildHelpActions", () => {
  it("emits one command:<verb> button per catalog entry, no nav when single page", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(25),
    });
    const actions = buildHelpActions({ page });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual([
      "command:resume",
      "command:new",
      "command:status",
      "command:detach",
      "command:monitor",
      "command:help",
    ]);
  });

  it("styles `command:resume` as primary, leaves the rest neutral (matches existing single-button shape)", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(25),
    });
    const actions = buildHelpActions({ page });
    const resume = actions.find((a) => a.id === "command:resume");
    expect(resume?.style).toBe("primary");
    const newThread = actions.find((a) => a.id === "command:new");
    expect(newThread?.style).toBeUndefined();
    const status = actions.find((a) => a.id === "command:status");
    expect(status?.style).toBeUndefined();
  });

  it("gives command buttons a two-column row layout hint", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(25),
    });
    const actions = buildHelpActions({ page });

    expect(actions.map((a) => a.layout)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 2, column: 0 },
      { row: 2, column: 1 },
    ]);
  });

  it("renders Next + Cancel on the first page of a multi-page catalog (no Prev)", () => {
    const synthetic = syntheticCatalog(12);
    const page = paginateHelpCatalog({
      catalog: synthetic,
      profile: profileWithMaxActions(25),
      pageIndex: 0,
    });
    const ids = buildHelpActions({ page }).map((a) => a.id);
    expect(ids).toContain("help:page:next");
    expect(ids).toContain("help:cancel");
    expect(ids).not.toContain("help:page:prev");
  });

  it("renders Prev + Cancel on the last page of a multi-page catalog (no Next)", () => {
    const synthetic = syntheticCatalog(12);
    const page = paginateHelpCatalog({
      catalog: synthetic,
      profile: profileWithMaxActions(25),
      pageIndex: 1,
    });
    const ids = buildHelpActions({ page }).map((a) => a.id);
    expect(ids).toContain("help:page:prev");
    expect(ids).toContain("help:cancel");
    expect(ids).not.toContain("help:page:next");
  });

  it("nav buttons carry pageIndex in `value` so the callback handler is stateless", () => {
    const synthetic = syntheticCatalog(12);
    const page = paginateHelpCatalog({
      catalog: synthetic,
      profile: profileWithMaxActions(25),
      pageIndex: 0,
    });
    const actions = buildHelpActions({ page });
    const next = actions.find((a) => a.id === "help:page:next");
    expect(next?.value).toEqual({ pageIndex: 1 });
  });

  it("emits an empty action array when the profile is too constrained for buttons", () => {
    const page = paginateHelpCatalog({
      profile: profileWithMaxActions(2),
    });
    expect(buildHelpActions({ page })).toEqual([]);
  });
});
