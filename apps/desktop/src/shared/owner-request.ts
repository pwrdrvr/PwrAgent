import type {
  NavigationLaunchpadConfigRequest,
  NavigationQueryRequest,
  NavigationQueueProjectionRequest,
  NavigationSelectedDetailRequest,
} from "@pwragent/shared";

/** The first owner operations admitted by the native window transport. */
export type OwnerNavigationRequest =
  | { method: "backend.getNavigationQueryPage"; params: NavigationQueryRequest }
  | { method: "backend.getNavigationSelectedDetail"; params: NavigationSelectedDetailRequest }
  | { method: "backend.getNavigationQueueProjection"; params: NavigationQueueProjectionRequest }
  | { method: "backend.getNavigationLaunchpadConfig"; params: NavigationLaunchpadConfigRequest };
