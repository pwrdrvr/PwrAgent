import { buildModelMenu, formatModelOptionLabel, modelMenuOtherLabel } from "@pwragent/shared";
import type { ModelMenuEntry } from "@pwragent/shared";
import {
  applyActionCapabilityLimits,
  capabilityProfilePageSize,
  type MessagingCapabilityProfile,
  type MessagingJsonValue,
  type MessagingSurfaceAction,
} from "@pwragent/messaging-interface";

type MessagingModelOption = ModelMenuEntry & { label?: string; current?: boolean };

/** All messaging model pickers use the desktop rule and the same nested pages. */
export function buildMessagingModelMenuActions<T extends MessagingModelOption>(params: {
  kind: string | undefined;
  models: readonly T[];
  thread?: { model?: string };
  currentModelId?: string;
  menuValue?: MessagingJsonValue;
  menuActionId: string;
  selectActionId: string | ((model: T) => string);
  backAction: MessagingSurfaceAction;
  footerActions?: MessagingSurfaceAction[];
  capabilityProfile?: MessagingCapabilityProfile;
}): MessagingSurfaceAction[] {
  const menu = buildModelMenu(params);
  const value = params.menuValue && typeof params.menuValue === "object" && !Array.isArray(params.menuValue)
    ? params.menuValue
    : {};
  const group = value.modelMenu === "provider"
    ? menu.providerGroups.find((candidate) => candidate.providerId === value.providerId)
    : undefined;
  const section = value.modelMenu === "other" && menu.other.length > 0
    ? "other"
    : group ? "provider" : "primary";
  const pageValue = (pageIndex: number): MessagingJsonValue => ({
    modelMenu: section,
    ...(group ? { providerId: group.providerId } : {}),
    pageIndex,
  });
  const models = section === "other" ? menu.other : group?.models ?? menu.primary;
  const entries: MessagingSurfaceAction[] = models.map((model, index) => ({
    id: typeof params.selectActionId === "string" ? params.selectActionId : params.selectActionId(model),
    label: `${formatModelOptionLabel(model)}${
      (params.currentModelId ? model.id === params.currentModelId : model.current) ? " (current)" : ""
    }`,
    fallbackText: String(index + 1),
    style: "secondary",
    priority: 10 + index,
    value: { model: model.id },
  }));
  if (section === "primary") {
    if (menu.other.length > 0) {
      entries.push({
        id: `${params.menuActionId}:other`,
        label: modelMenuOtherLabel(params.kind),
        fallbackText: "other",
        style: "secondary",
        value: { modelMenu: "other" },
      });
    }
    for (const [index, provider] of menu.providerGroups.entries()) {
      entries.push({
        id: `${params.menuActionId}:provider:${index}`,
        label: provider.label,
        fallbackText: provider.providerId,
        style: "secondary",
        value: { modelMenu: "provider", providerId: provider.providerId },
      });
    }
  }
  const backAction = section === "primary" ? params.backAction : {
    id: `${params.menuActionId}:back`,
    label: "Back",
    fallbackText: "back",
    style: "secondary" as const,
    priority: 1,
    value: { modelMenu: "primary" },
  };
  const footer = [...(params.footerActions ?? []), backAction];
  const pageSizeFor = (navigationCount: number) => params.capabilityProfile
    ? capabilityProfilePageSize(params.capabilityProfile, footer.length + navigationCount, 8)
    : 8;
  const pageSize = Math.max(1, entries.length <= pageSizeFor(0) ? pageSizeFor(0) : pageSizeFor(2));
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const requestedPage = typeof value.pageIndex === "number" && Number.isSafeInteger(value.pageIndex)
    ? value.pageIndex : 0;
  const pageIndex = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const actions = entries.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  if (pageIndex > 0) {
    actions.push({
      id: `${params.menuActionId}:previous`, label: "Previous", fallbackText: "previous",
      style: "secondary", priority: 2, value: pageValue(pageIndex - 1),
    });
  }
  if (pageIndex + 1 < pageCount) {
    actions.push({
      id: `${params.menuActionId}:next`, label: "Next", fallbackText: "next",
      style: "secondary", priority: 2, value: pageValue(pageIndex + 1),
    });
  }
  return applyActionCapabilityLimits([...actions, ...footer], params.capabilityProfile);
}
