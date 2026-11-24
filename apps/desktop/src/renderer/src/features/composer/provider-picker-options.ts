import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import {
  describeCodexModelProviderEntry,
  partitionProviderPickerEntries,
  type ProviderPickerEntry,
} from "@pwragent/shared/provider-picker";
import { formatBackendLabel } from "../../lib/backend-label";
import type { ComposerDropdownOption } from "./ComposerDropdown";

function providerPickerOption(
  entry: ProviderPickerEntry,
  backends: BackendSummary[] | undefined,
): ComposerDropdownOption {
  return entry.codexModelProviderId
    ? {
      label: entry.label ?? entry.codexModelProviderId,
      value: entry.value,
      ...describeCodexModelProviderEntry(entry),
    }
    : { label: formatBackendLabel(entry.backend, backends), value: entry.value };
}

/**
 * The Provider picker's `ComposerDropdown` props. A Codex model provider that
 * cannot be used now (its endpoint is down, or it offers no model) moves to an
 * Unavailable submenu, so the main list holds only the providers that work.
 */
export function providerPickerDropdownOptions(
  entries: readonly ProviderPickerEntry[],
  backends: BackendSummary[] | undefined,
): {
  options: ComposerDropdownOption[];
  otherOptions: ComposerDropdownOption[];
  otherLabel: string;
} {
  const { available, unavailable } = partitionProviderPickerEntries(entries);
  return {
    options: available.map((entry) => providerPickerOption(entry, backends)),
    otherOptions: unavailable.map((entry) => providerPickerOption(entry, backends)),
    otherLabel: "Unavailable",
  };
}
