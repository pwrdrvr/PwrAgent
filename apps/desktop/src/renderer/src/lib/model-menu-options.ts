import type { BackendModelOption, BackendSummary } from "@pwragent/shared";

/** Keep the composer and to-do picker consistent without hiding catalog entries. */
export function splitModelMenuOptions(
  kind: BackendSummary["kind"] | undefined,
  models: readonly BackendModelOption[],
): { primary: BackendModelOption[]; other: BackendModelOption[] } {
  const ownModels = models.filter((model) => !model.providerId);
  const hasGpt6 = ownModels.some((model) => /^gpt-6(?:[.-]|$)/iu.test(model.id));
  const hasSolReplacement = ownModels.some((model) => /^gpt-6\.1-(?:sol|terra)$/iu.test(model.id));
  const primary: BackendModelOption[] = [];
  const other: BackendModelOption[] = [];
  for (const model of models) {
    const isOther = kind === "claude"
      ? model.other
      : kind === "codex" && !model.providerId && (
        (hasGpt6 && /^gpt-5\.(?:5|6)(?:-|$)/iu.test(model.id))
        || (hasSolReplacement && /^gpt-6-sol$/iu.test(model.id))
      );
    (isOther ? other : primary).push(model);
  }
  return { primary, other };
}
