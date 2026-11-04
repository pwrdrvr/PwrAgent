import { fireEvent } from "@testing-library/react";
import type { BackendModelOption } from "@pwragent/shared";

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

/** Section titles of an open `ComposerDropdown` list, in order. */
export function composerDropdownGroupLabels(root: ParentNode = document): string[] {
  return [...root.querySelectorAll(".composer-dropdown__group-label")].map((label) =>
    label.textContent ?? "",
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
  options: { withProvider?: boolean } = {},
): Array<{ group?: string; labels: string[] }> {
  return [
    { labels: [...leading, ...CURRENT_CODEX_MODEL_LABELS] },
    { group: "Other models", labels: SUPERSEDED_CODEX_MODEL_LABELS },
    ...(options.withProvider === false
      ? []
      : [{ group: PROVIDER_MODEL.providerLabel!, labels: [PROVIDER_MODEL.label!] }]),
  ];
}
