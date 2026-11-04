import { fireEvent, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { expect } from "vitest";
import {
  buildModelMenu,
  modelMenuOtherLabel,
  type BackendModelOption,
} from "@pwragent/shared";

/**
 * A Codex catalog in the order Codex lists it, with superseded models mixed
 * in and one model served by a Codex model provider. Every model picker must
 * show the current four, put the superseded four under Other, and title the
 * provider's model by its provider.
 */
export const CURRENT_CODEX_MODEL_LABELS = [
  "GPT-6-Astra",
  "GPT-6.1-Sol",
  "GPT-6.1-Terra",
  "GPT-6-Luna",
];

export const SUPERSEDED_CODEX_MODEL_LABELS = [
  "GPT-6-Sol",
  "GPT-5.6-Sol",
  "GPT-5.6-Terra",
  "GPT-5.6-Luna",
];

export const PROVIDER_MODEL: BackendModelOption = {
  id: "@bonsai/ternary-bonsai-27b",
  label: "Ternary-Bonsai-27B",
  providerId: "bonsai",
  providerLabel: "PrismML Bonsai (local)",
};

const CATALOG_ORDER = [
  "GPT-6-Astra",
  "GPT-6.1-Sol",
  "GPT-6-Sol",
  "GPT-6.1-Terra",
  "GPT-6-Luna",
  "GPT-5.6-Sol",
  "GPT-5.6-Terra",
  "GPT-5.6-Luna",
];

export function codexCatalogModels(
  options: { withProvider?: boolean } = {},
): BackendModelOption[] {
  return [
    ...CATALOG_ORDER.map((label) => ({
      id: label.toLowerCase(),
      label,
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      ...(label === "GPT-6.1-Sol" ? { current: true } : {}),
    })),
    ...(options.withProvider === false ? [] : [PROVIDER_MODEL]),
  ];
}

/** Option labels of an open `ComposerDropdown` list, in order. */
export function composerDropdownOptionLabels(root: ParentNode = document): string[] {
  return [...root.querySelectorAll('[role="option"]')].map((option) =>
    option.querySelector(".composer-dropdown__option-label")?.textContent ?? "",
  );
}

/**
 * A `Select` list as titled sections, in order: options outside any group
 * read as one section with no title. Leaves the list as it found it.
 */
export function selectSections(
  trigger: HTMLElement,
): Array<{ group?: string; labels: string[] }> {
  const wasOpen = trigger.getAttribute("aria-expanded") === "true";
  if (!wasOpen) fireEvent.click(trigger);
  const id = trigger.getAttribute("aria-controls");
  const listbox = id === null ? null : document.getElementById(id);
  if (listbox === null) throw new Error("The Select did not open.");
  const label = (option: Element) =>
    option.querySelector(".select-option__label")?.textContent ?? "";
  const sections: Array<{ group?: string; labels: string[] }> = [];
  for (const child of listbox.children) {
    if (child.getAttribute("role") === "group") {
      sections.push({
        group: child.querySelector(".select-group__label")?.textContent ?? "",
        labels: [...child.querySelectorAll('[role="option"]')].map(label),
      });
    } else if (child.getAttribute("role") === "option") {
      const last = sections.at(-1);
      if (last && last.group === undefined) last.labels.push(label(child));
      else sections.push({ labels: [label(child)] });
    }
  }
  if (!wasOpen) fireEvent.click(trigger);
  return sections;
}

/** The sections every Settings model list must show for `codexCatalogModels()`. */
export function expectedCodexSelectSections(
  leading: string[],
): Array<{ group?: string; labels: string[] }> {
  return [
    { labels: [...leading, ...CURRENT_CODEX_MODEL_LABELS] },
    { group: "Other models", labels: SUPERSEDED_CODEX_MODEL_LABELS },
    { group: PROVIDER_MODEL.providerLabel!, labels: [PROVIDER_MODEL.label!] },
  ];
}

/**
 * Catalogs as main builds them, for property tests: Codex's own models in
 * any order and any subset, mixed with models a Codex model provider serves
 * (`@<provider>/<model>`), some named like a superseded Codex model.
 */
const OWN_CODEX_LABELS = [
  "GPT-5.4", "GPT-5.5", "GPT-5.5-Codex", "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna",
  "GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna", "GPT-6.1-Sol", "GPT-6.1-Terra",
];
const PROVIDER_CATALOG: BackendModelOption[] = [
  PROVIDER_MODEL,
  {
    id: "@bonsai/ternary-bonsai-8b",
    label: "Ternary-Bonsai-8B",
    providerId: "bonsai",
    providerLabel: "PrismML Bonsai (local)",
  },
  { id: "@openrouter/gpt-5.6-sol", label: "gpt-5.6-sol", providerId: "openrouter" },
  { id: "@openrouter/gpt-5.5", label: "gpt-5.5", providerId: "openrouter" },
];

export const codexCatalogArbitrary: fc.Arbitrary<BackendModelOption[]> = fc
  .shuffledSubarray(
    [
      ...OWN_CODEX_LABELS.map((label): BackendModelOption => ({
        id: label.toLowerCase(),
        label,
        supportsReasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
      })),
      ...PROVIDER_CATALOG,
    ],
    { minLength: 1 },
  )
  .filter((models) => models.some((model) => !model.providerId));

/** Claude catalogs: Claude marks its own older models with `other`. */
export const claudeCatalogArbitrary: fc.Arbitrary<BackendModelOption[]> = fc
  .shuffledSubarray(["Opus", "Sonnet", "Haiku", "Fable", "Opus 4.7", "Sonnet 4.6"], { minLength: 1 })
  .chain((labels) => fc.tuple(...labels.map((label) => fc.boolean().map((other): BackendModelOption => ({
    id: label.toLowerCase().replace(/[ .]/g, "-"),
    label,
    ...(other ? { other: true } : {}),
  })))));

/** A catalog and one model in it, such as a thread's or a saved choice. */
export const codexCatalogWithChoiceArbitrary = codexCatalogArbitrary.chain((models) =>
  fc.tuple(fc.constant(models), fc.constantFrom(...models)),
);

const labelOf = (model: BackendModelOption) => model.label ?? model.id;

/**
 * What a model chip (`ModelDropdown`) must list for a catalog, by the shared
 * rule: `rows` is every option in the open list, in order, with the Other
 * entry where it belongs; `other` is the Other submenu.
 */
export function expectedModelDropdown(params: {
  kind: string;
  models: readonly BackendModelOption[];
  thread?: { model?: string };
  leading?: string[];
}): { rows: string[]; groups: Array<{ label: string; rows: string[] }>; other: string[] } {
  const menu = buildModelMenu(params);
  const groups = menu.providerGroups.map((group) => ({
    label: group.label,
    rows: group.models.map(labelOf),
  }));
  return {
    rows: [
      ...(params.leading ?? []),
      ...menu.primary.map(labelOf),
      ...(menu.other.length > 0 ? [modelMenuOtherLabel(params.kind)] : []),
      ...groups.flatMap((group) => group.rows),
    ],
    groups,
    other: menu.other.map(labelOf),
  };
}

/** An open `ComposerDropdown` list as rows and titled provider groups. */
export function readModelDropdown(list: HTMLElement): {
  rows: string[];
  groups: Array<{ label: string; rows: string[] }>;
} {
  return {
    rows: composerDropdownOptionLabels(list),
    groups: [...list.querySelectorAll('[role="group"]')].map((group) => ({
      label: group.getAttribute("aria-label") ?? "",
      rows: composerDropdownOptionLabels(group),
    })),
  };
}

/** What a Settings model list (`Select`) must show for a catalog, by the shared rule. */
export function expectedModelSelectSections(params: {
  kind: string;
  models: readonly BackendModelOption[];
  leading?: string[];
}): Array<{ group?: string; labels: string[] }> {
  const menu = buildModelMenu(params);
  const sections: Array<{ group?: string; labels: string[] }> = [];
  const lead = [...(params.leading ?? []), ...menu.primary.map(labelOf)];
  if (lead.length > 0) sections.push({ labels: lead });
  if (menu.other.length > 0) sections.push({ group: "Other models", labels: menu.other.map(labelOf) });
  for (const group of menu.providerGroups) {
    sections.push({ group: group.label, labels: group.models.map(labelOf) });
  }
  return sections;
}

/**
 * Check an open model chip against `expectedModelDropdown`, opening its Other
 * submenu when the rule puts anything there.
 */
export function expectModelDropdownToList(
  list: HTMLElement,
  ariaLabel: string,
  expected: ReturnType<typeof expectedModelDropdown>,
  otherLabel = "Other",
): void {
  expect(readModelDropdown(list)).toEqual({ rows: expected.rows, groups: expected.groups });
  if (expected.other.length === 0) return;
  fireEvent.click(within(list).getByRole("option", { name: otherLabel }));
  const other = screen.getByRole("listbox", { name: `${ariaLabel}: ${otherLabel}` });
  expect(composerDropdownOptionLabels(other)).toEqual(expected.other);
}
