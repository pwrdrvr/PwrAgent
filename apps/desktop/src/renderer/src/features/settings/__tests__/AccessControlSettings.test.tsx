import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUILT_IN_ROLES,
  MESSAGING_PERMISSION_CATALOG,
  RBAC_BUILT_IN_ROLE_IDS,
  type ReadRbacKnownSubjectsResponse,
  type ReadRbacPolicyResponse,
} from "@pwragent/shared";

import type { DesktopApi } from "../../../lib/desktop-api";
import { AccessControlSettings } from "../AccessControlSettings";

afterEach(() => {
  cleanup();
});

function makeApi(overrides?: Partial<DesktopApi>): DesktopApi {
  const policy: ReadRbacPolicyResponse = {
    enforced: true,
    roles: [...BUILT_IN_ROLES],
    attachments: [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U1" },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
        displayName: "Alice",
      },
    ],
    permissionCatalog: MESSAGING_PERMISSION_CATALOG,
  };
  const subjects: ReadRbacKnownSubjectsResponse = {
    subjects: [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U1" },
        displayName: "Alice",
      },
      {
        subject: { kind: "bucket", platform: "slack", bucket: "channel_any_user" },
        displayName: "Any channel user",
        bucket: true,
      },
    ],
  };
  return {
    readRbacPolicy: vi.fn(async () => policy),
    readRbacKnownSubjects: vi.fn(async () => subjects),
    writeRbacAttachment: vi.fn(async () => ({ ok: true })),
    setRbacEnforced: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as DesktopApi;
}

describe("AccessControlSettings", () => {
  it("renders the three columns with known actors, roles, and permissions", async () => {
    render(<AccessControlSettings desktopApi={makeApi()} />);
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Actors")).toBeInTheDocument();
    expect(screen.getByLabelText("Roles")).toBeInTheDocument();
    expect(screen.getByLabelText("Permissions")).toBeInTheDocument();
    // A bucket subject renders with its scope-distinguishing badge.
    expect(screen.getByText("Any channel user")).toBeInTheDocument();
    // The danger callout for full access is always shown.
    expect(
      screen.getByText(/Codex Full Access is escalation-equivalent/i),
    ).toBeInTheDocument();
  });

  it("toggles a role on a subject via the role chip", async () => {
    const api = makeApi();
    render(<AccessControlSettings desktopApi={api} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    // Alice's row has a "Power User" chip that is currently off; clicking adds it.
    const chips = screen.getAllByTitle(/Power User/);
    fireEvent.click(chips[0]);
    await waitFor(() => {
      expect(api.writeRbacAttachment).toHaveBeenCalledTimes(1);
    });
    const call = (api.writeRbacAttachment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.attachment.roleIds).toContain(RBAC_BUILT_IN_ROLE_IDS.chatUser);
    expect(call.attachment.roleIds).toContain(RBAC_BUILT_IN_ROLE_IDS.powerUser);
  });

  it("pins a role on click so the trace persists, and clears on a second click", async () => {
    render(<AccessControlSettings desktopApi={makeApi()} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    // Pin the Chat User role node (scoped to the Roles column — the name also
    // appears as an actor chip).
    const rolesCol = screen.getByLabelText("Roles");
    const roleNode = within(rolesCol).getByText("Chat User").closest(".rbac-node");
    expect(roleNode).not.toBeNull();
    fireEvent.click(roleNode as Element);
    // The pinned state surfaces a clear affordance and marks the node.
    expect(
      screen.getByRole("button", { name: /Clear selection/i }),
    ).toBeInTheDocument();
    expect((roleNode as Element).className).toContain("is-pinned");
    // Clicking again unpins.
    fireEvent.click(roleNode as Element);
    expect(
      screen.queryByRole("button", { name: /Clear selection/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the migration banner when enforcement is off", async () => {
    const api = makeApi({
      readRbacPolicy: vi.fn(async () => ({
        enforced: false,
        roles: [...BUILT_IN_ROLES],
        attachments: [],
        permissionCatalog: MESSAGING_PERMISSION_CATALOG,
      })),
    });
    render(<AccessControlSettings desktopApi={api} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Access control is not enforced/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Enable access control/i }),
    ).toBeInTheDocument();
  });
});
