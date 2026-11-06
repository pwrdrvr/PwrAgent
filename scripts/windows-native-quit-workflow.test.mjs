import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/windows-native-quit-repro.yml", import.meta.url), "utf8");
const diagnosticLabel = "ci:windows-shutdown-diagnostics";

function evaluate(expression, { action = "synchronize", label, event = "pull_request" } = {}) {
  return runInNewContext(expression.replace(
    "github.event.pull_request.labels.*.name",
    "github.event.pull_request.labels.map(label => label.name)",
  ), {
    github: {
      event_name: event,
      repository: "pwrdrvr/PwrAgent",
      ref: "refs/heads/investigate/native-quit",
      event: event === "pull_request" ? {
        action, label: label === undefined ? undefined : { name: label },
        pull_request: {
          number: 123, head: { repo: { full_name: "pwrdrvr/PwrAgent" } },
          labels: [{ name: diagnosticLabel }],
        },
      } : { pull_request: {} },
    },
    contains: (items, value) => items.includes(value),
  });
}

function concurrencyGroup(options) {
  return workflow.match(/^  group: (.+)$/m)[1].replace(
    /\$\{\{([\s\S]*?)\}\}/g, (_match, expression) => evaluate(expression, options),
  );
}

test.each(["ci:build-preview", "ci:linux-packages"])("unrelated label %s cannot replace a diagnostic run", (label) => {
  const options = { action: "labeled", label };
  const condition = workflow.match(/^    if: >-\n([\s\S]*?)\n    runs-on:/m)[1].trim();
  expect(evaluate(condition, options)).toBe(false);
  expect(concurrencyGroup(options)).not.toBe(concurrencyGroup());
});

test.each(["opened", "synchronize", "reopened", "labeled"])("diagnostic %s events share the PR queue", (action) => {
  expect(concurrencyGroup({ action, label: diagnosticLabel })).toBe("windows-native-quit-123");
});

test("manual diagnostics retain the ref queue", () => {
  expect(concurrencyGroup({ event: "workflow_dispatch" })).toBe("windows-native-quit-refs/heads/investigate/native-quit");
});
