import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/linux-packaging.yml", import.meta.url), "utf8");

function evaluate(expression, { event = "pull_request", action = "synchronize", label, labels = [], fork = false } = {}) {
  const js = expression.replace(
    "github.event.pull_request.labels.*.name",
    "github.event.pull_request.labels.map(label => label.name)",
  );
  return runInNewContext(js, {
    github: {
      workflow: "Linux Packaging",
      ref: "refs/heads/main",
      repository: "pwrdrvr/PwrAgent",
      event_name: event,
      event: event === "pull_request" ? {
        action,
        label: label === undefined ? undefined : { name: label },
        pull_request: {
          number: 123,
          head: { repo: { full_name: fork ? "contributor/PwrAgent" : "pwrdrvr/PwrAgent" } },
          labels: labels.map((name) => ({ name })),
        },
      } : {},
    },
    contains: (items, value) => items.includes(value),
  });
}

function packages(options) {
  const job = workflow.split("\n  package:\n")[1];
  const expression = job.match(/^    if: (?:>-\s*\n\s*)?\$\{\{([\s\S]*?)\}\}/m)?.[1];
  // A job without a condition runs on every event that starts the workflow.
  return expression ? evaluate(expression, options) : true;
}

function concurrencyGroup(options) {
  const group = workflow.match(/^  group: (.+)$/m)[1];
  return group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression) => evaluate(expression, options));
}

test.each([
  { action: "labeled", label: "ci:linux-packages", labels: ["ci:linux-packages"] },
  { action: "synchronize", labels: ["ci:linux-packages"] },
  { action: "reopened", labels: ["ci:build-preview", "ci:linux-packages"] },
])("packages Linux for an opted-in PR ($action)", (options) => {
  expect(packages(options)).toBe(true);
});

test.each([
  { action: "synchronize" },
  { action: "reopened" },
  { action: "labeled", label: "ci:build-preview", labels: ["ci:build-preview"] },
  { action: "labeled", label: "ci:windows-package", labels: ["ci:windows-package"] },
  { action: "labeled", label: "ci:build-preview", labels: ["ci:build-preview", "ci:linux-packages"] },
  { action: "labeled", label: "ci:linux-packages", labels: ["ci:linux-packages"], fork: true },
  { action: "synchronize", labels: ["ci:linux-packages"], fork: true },
  { action: "reopened", labels: ["ci:linux-packages"], fork: true },
])("skips Linux packaging for an unlabeled, unrelated-label, or fork PR %#", (options) => {
  expect(packages(options)).toBe(false);
});

test("manual packaging does not require a PR or label", () => {
  expect(packages({ event: "workflow_dispatch" })).toBe(true);
});

test("label addition, pushes, and reopens share the packaging queue", () => {
  const group = concurrencyGroup({ action: "labeled", label: "ci:linux-packages" });
  expect(concurrencyGroup({ action: "synchronize" })).toBe(group);
  expect(concurrencyGroup({ action: "reopened" })).toBe(group);
});

test("unrelated label events cannot cancel active or pending packaging", () => {
  const group = concurrencyGroup({ action: "synchronize", labels: ["ci:linux-packages"] });
  expect(concurrencyGroup({
    action: "labeled", label: "ci:build-preview", labels: ["ci:linux-packages", "ci:build-preview"],
  })).not.toBe(group);
});

test("manual dispatch retains its ref-based packaging queue", () => {
  expect(concurrencyGroup({ event: "workflow_dispatch" })).toBe("Linux Packaging-refs/heads/main");
});

test("label opt-in works for any PR without a changed-path filter", () => {
  const trigger = workflow.split("\n  pull_request:\n")[1]?.split(/\n\S/)[0];
  const types = trigger.match(/^ {6}- (\w+)$/gm)?.map((line) => line.trim().slice(2));
  expect(types).toEqual(["labeled", "synchronize", "reopened"]);
  expect(trigger).not.toMatch(/^    paths(?:-ignore)?:/m);
});
