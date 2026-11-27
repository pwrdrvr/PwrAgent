import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/scaling-audit.yml", import.meta.url), "utf8");
const optIn = "ci:scaling-audit";

test("only four PR events can dispatch the audit", () => {
  const trigger = workflow.split("\non:\n")[1].split(/\n\S/)[0].trim();
  expect(trigger).toBe("pull_request:\n    types: [opened, reopened, synchronize, labeled]");
});

test.each([
  ["opened", [], undefined, false],
  ["synchronize", ["ci:full"], undefined, false],
  ["labeled", [optIn, "ci:full"], "ci:full", false],
  ["labeled", [optIn], optIn, true],
  ["opened", [optIn], undefined, true],
  ["synchronize", [optIn], undefined, true],
  ["reopened", [optIn], undefined, true],
])("%s with %j and event label %s", (action, labels, label, expected) => {
  const expression = workflow.match(/\n    if: >-\n(.*?)\n    \S/s)[1]
    .replace("github.event.pull_request.labels.*.name", "labels");
  const runs = runInNewContext(expression, {
    github: { event: { action, label: { name: label } } },
    contains: (items, item) => items.includes(item), labels,
  });
  expect(runs).toBe(expected);
});
