import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractReviewFromExitedItem,
  isReviewTerminalEventMatch,
} from "../drivers/review-event-normalizer";
import {
  discoverWorkspacePackages,
  resolveWorkspacePackageSpecifier,
} from "../../shared/workspace-resolve.mjs";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("codex-native review event correlation and output normalization", () => {
  it("matches terminal turn events via relatedReviewTurnId when Codex native emits a mismatched inner turn id", () => {
    expect(isReviewTerminalEventMatch({
      expectedTurnId: "outer-review-turn-1",
      eventTurnId: "codex-inner-turn-99",
      relatedReviewTurnId: "outer-review-turn-1",
    })).toBe(true);

    expect(isReviewTerminalEventMatch({
      expectedTurnId: "outer-review-turn-1",
      eventTurnId: "outer-review-turn-1",
      relatedReviewTurnId: undefined,
    })).toBe(true);

    expect(isReviewTerminalEventMatch({
      expectedTurnId: "outer-review-turn-1",
      eventTurnId: "unrelated-turn-2",
      relatedReviewTurnId: undefined,
    })).toBe(false);

    expect(isReviewTerminalEventMatch({
      expectedTurnId: "outer-review-turn-1",
      eventTurnId: undefined,
      relatedReviewTurnId: undefined,
    })).toBe(false);
  });

  it("parses Codex native plain-text exitedReviewMode findings and clean 'No findings.' reviews", () => {
    const withFindings = extractReviewFromExitedItem(
      {
        id: "exit-1",
        type: "exitedReviewMode",
        review: [
          "Found one correctness bug in the diff.",
          "",
          "Full review comments:",
          "- [P1] Drop stale cache entry — /tmp/repo/src/cache.ts:42-48",
          "  When invalidation runs concurrently, stale entries survive.",
        ].join("\n"),
      },
      { allowPlainTextReview: true },
    );

    expect(withFindings.reviewOutput?.overall_correctness).toBe("patch is incorrect");
    expect(withFindings.reviewOutput?.findings).toHaveLength(1);
    expect(withFindings.reviewOutput?.findings[0]).toMatchObject({
      title: "Drop stale cache entry",
      priority: 1,
      code_location: {
        absolute_file_path: "/tmp/repo/src/cache.ts",
        line_range: { start: 42, end: 48 },
      },
    });

    const clean = extractReviewFromExitedItem(
      {
        id: "exit-2",
        type: "exitedReviewMode",
        review: "No findings.",
      },
      { allowPlainTextReview: true },
    );
    expect(clean.reviewOutput).toMatchObject({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No findings.",
    });
  });

  it("rejects failure sentinels, unparseable comments sections, and non-JSON managed reviews", () => {
    const noResponse = extractReviewFromExitedItem(
      {
        id: "exit-fail",
        type: "exitedReviewMode",
        review: "Reviewer failed to output a response.",
      },
      { allowPlainTextReview: true },
    );
    expect(noResponse.reviewOutput).toBeUndefined();

    const unparsedComments = extractReviewFromExitedItem(
      {
        id: "exit-unparsed",
        type: "exitedReviewMode",
        review: "Issues found.\n\nFull review comments:\n1. Something broke in foo.ts without standard bullet format",
      },
      { allowPlainTextReview: true },
    );
    expect(unparsedComments.reviewOutput).toBeUndefined();

    const managedPlainProse = extractReviewFromExitedItem(
      {
        id: "exit-managed-prose",
        type: "exitedReviewMode",
        review: "No findings.",
      },
      { allowPlainTextReview: false },
    );
    expect(managedPlainProse.reviewOutput).toBeUndefined();
  });

  it("normalizes structured outputs from data.review_output, item.reviewOutput, and JSON text", () => {
    const payload = {
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "Clean.",
    };

    expect(
      extractReviewFromExitedItem({ data: { review_output: payload } }).reviewOutput?.overall_correctness,
    ).toBe("patch is correct");

    expect(
      extractReviewFromExitedItem({ reviewOutput: payload }).reviewOutput?.overall_explanation,
    ).toBe("Clean.");

    expect(
      extractReviewFromExitedItem({ review: JSON.stringify(payload) }).reviewOutput?.findings,
    ).toEqual([]);
  });
});

describe("workspace-resolve for isolated --rev builds", () => {
  it("resolves every @pwragent/* workspace package strictly inside targetRepo without node_modules symlinks", () => {
    const targetRepo = makeTempDir("pwragent-eval-rev-resolve-");
    const write = (rel: string, content: string) => {
      const full = path.join(targetRepo, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    };

    const sharedPkg = write("packages/shared/package.json", JSON.stringify({
      name: "@pwragent/shared",
      exports: { "./*": "./src/*.ts" },
    }));
    const sharedFile = write("packages/shared/src/review-output.ts", "export const v = 'target-rev';\n");
    write("packages/owner-core/package.json", JSON.stringify({
      name: "@pwragent/owner-core",
      exports: { "./*": "./src/*.ts" },
    }));
    const ownerCoreFile = write("packages/owner-core/src/policy.ts", "export const p = 'target-rev';\n");
    write("packages/messaging/interface/package.json", JSON.stringify({
      name: "@pwragent/messaging-interface",
      exports: { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
    }));
    const msgIfaceFile = write("packages/messaging/interface/src/index.ts", "export const m = 1;\n");
    write("packages/messaging/providers/line/package.json", JSON.stringify({
      name: "@pwragent/messaging-provider-line",
      exports: { ".": "./src/index.ts", "./rich-menu.png": "./assets/pwragent-line-rich-menu.png" },
    }));
    const lineAsset = write("packages/messaging/providers/line/assets/pwragent-line-rich-menu.png", "png");
    const desktopMainFile = write("apps/desktop/src/main/owner-services.ts", "export const s = 1;\n");

    expect(fs.existsSync(sharedPkg)).toBe(true);
    const map = discoverWorkspacePackages(targetRepo);

    expect(resolveWorkspacePackageSpecifier("@pwragent/shared/review-output", targetRepo, map)).toBe(sharedFile);
    expect(resolveWorkspacePackageSpecifier("@pwragent/owner-core/policy", targetRepo, map)).toBe(ownerCoreFile);
    expect(resolveWorkspacePackageSpecifier("@pwragent/messaging-interface", targetRepo, map)).toBe(msgIfaceFile);
    expect(resolveWorkspacePackageSpecifier("@pwragent/messaging-provider-line/rich-menu.png", targetRepo, map)).toBe(lineAsset);
    expect(resolveWorkspacePackageSpecifier("@pwragent/desktop-main/owner-services", targetRepo, map)).toBe(desktopMainFile);
    expect(resolveWorkspacePackageSpecifier("@pwragent/nonexistent/foo", targetRepo, map)).toBeNull();
  });
});
