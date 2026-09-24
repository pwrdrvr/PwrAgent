import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUILT_IN_ROLES,
  MESSAGING_PERMISSION_CATALOG,
  RBAC_BUILT_IN_ROLE_IDS,
  type RbacRoleDefinition,
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

type User = ReturnType<typeof userEvent.setup>;

// Walks Tab until `target` has focus rather than focusing it directly, so a
// pass proves the keyboard can reach it. The bound is past every stop on the
// screen, so an unreachable target cycles round and fails the assertion.
async function tabTo(user: User, target: HTMLElement): Promise<void> {
  for (let step = 0; step < 200 && document.activeElement !== target; step += 1) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

function traceButton(label: string): HTMLElement {
  return screen.getByRole("button", { name: `Trace ${label}` });
}

function nodeOf(element: HTMLElement): HTMLElement {
  const node = element.closest<HTMLElement>(".rbac-node");
  expect(node).not.toBeNull();
  return node as HTMLElement;
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
    expect(traceButton("Chat User")).toHaveAttribute("aria-pressed", "true");
    // Clicking again unpins.
    fireEvent.click(roleNode as Element);
    expect(
      screen.queryByRole("button", { name: /Clear selection/i }),
    ).not.toBeInTheDocument();
    // The name is the card's own button, so a click on it pins once, not twice.
    fireEvent.click(traceButton("Chat User"));
    expect(traceButton("Chat User")).toHaveAttribute("aria-pressed", "true");
  });

  it("reaches each kind of node by Tab and pins it with Enter or Space", async () => {
    const user = userEvent.setup();
    render(<AccessControlSettings desktopApi={makeApi()} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    for (const label of ["Alice", "Chat User", MESSAGING_PERMISSION_CATALOG[0].label]) {
      const trace = traceButton(label);
      await tabTo(user, trace);
      expect(trace).toHaveAttribute("aria-pressed", "false");

      await user.keyboard("{Enter}");
      expect(trace).toHaveAttribute("aria-pressed", "true");
      expect(nodeOf(trace)).toHaveClass("is-pinned");
      expect(
        screen.getByRole("button", { name: /Clear selection/i }),
      ).toBeInTheDocument();

      await user.keyboard(" ");
      expect(trace).toHaveAttribute("aria-pressed", "false");
      expect(nodeOf(trace)).not.toHaveClass("is-pinned");
      expect(
        screen.queryByRole("button", { name: /Clear selection/i }),
      ).not.toBeInTheDocument();
    }
  });

  it("traces a node while focus is anywhere inside it", async () => {
    const user = userEvent.setup();
    render(<AccessControlSettings desktopApi={makeApi()} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const alice = nodeOf(traceButton("Alice"));
    const bucket = nodeOf(traceButton("Any channel user"));

    await tabTo(user, traceButton("Alice"));
    expect(alice).toHaveClass("is-active");
    expect(bucket).toHaveClass("is-dim");
    // A preview, not a pin.
    expect(traceButton("Alice")).toHaveAttribute("aria-pressed", "false");

    // Tab walks on into Alice's role chips, and her card stays traced.
    await user.tab();
    expect(alice).toContainElement(document.activeElement as HTMLElement);
    expect(alice).toHaveClass("is-active");

    // The trace follows focus to the next card.
    await tabTo(user, traceButton("Any channel user"));
    expect(bucket).toHaveClass("is-active");
    expect(alice).toHaveClass("is-dim");

    // A focused permission opens its reverse map, as hovering one does.
    await tabTo(user, traceButton(MESSAGING_PERMISSION_CATALOG[0].label));
    expect(screen.getByText(/Reachable by/)).toBeInTheDocument();

    // Focus leaving the graph ends the preview.
    await user.click(document.body);
    expect(screen.queryByText(/Reachable by/)).not.toBeInTheDocument();
    expect(alice).not.toHaveClass("is-active");
    expect(alice).not.toHaveClass("is-dim");
  });

  it("keeps a focused card traced when the pointer leaves another card", async () => {
    const user = userEvent.setup();
    render(<AccessControlSettings desktopApi={makeApi()} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const alice = nodeOf(traceButton("Alice"));
    const bucket = nodeOf(traceButton("Any channel user"));

    await user.hover(bucket);
    expect(bucket).toHaveClass("is-active");
    await tabTo(user, traceButton("Alice"));
    expect(alice).toHaveClass("is-active");

    await user.unhover(bucket);
    expect(alice).toHaveClass("is-active");
    expect(bucket).toHaveClass("is-dim");
  });

  it("keeps role chips and Edit as their own Tab stops, apart from the pin", async () => {
    const custom: RbacRoleDefinition = {
      id: "triage",
      name: "Triage",
      builtIn: false,
      permissions: [MESSAGING_PERMISSION_CATALOG[0].id],
    };
    const policy: ReadRbacPolicyResponse = {
      enforced: true,
      roles: [...BUILT_IN_ROLES, custom],
      attachments: [
        {
          subject: { kind: "actor", platform: "slack", actorId: "U1" },
          roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
          displayName: "Alice",
        },
      ],
      permissionCatalog: MESSAGING_PERMISSION_CATALOG,
    };
    const api = makeApi({ readRbacPolicy: vi.fn(async () => policy) });
    const user = userEvent.setup();
    render(<AccessControlSettings desktopApi={api} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const chip = within(nodeOf(traceButton("Alice"))).getByRole("button", { name: "Power User" });
    await tabTo(user, chip);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.writeRbacAttachment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chip).toBeEnabled());
    expect(traceButton("Alice")).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByRole("button", { name: /Clear selection/i }),
    ).not.toBeInTheDocument();

    const edit = within(nodeOf(traceButton("Triage"))).getByRole("button", { name: "Edit" });
    await tabTo(user, edit);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Edit role" })).toBeInTheDocument();
    expect(traceButton("Triage")).toHaveAttribute("aria-pressed", "false");
  });

  it("warns when a persisted role reused a built-in id", async () => {
    const api = makeApi({
      readRbacPolicy: vi.fn(async () => ({
        enforced: true,
        roles: [...BUILT_IN_ROLES],
        attachments: [],
        permissionCatalog: MESSAGING_PERMISSION_CATALOG,
        ignoredReservedRoleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
      })),
    });
    render(<AccessControlSettings desktopApi={api} />);
    await waitFor(() =>
      expect(
        screen.getByText(/reuses a built-in name/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Built-in roles ship with the app/i),
    ).toBeInTheDocument();
  });

  it("shows the repair callout when the policy failed closed", async () => {
    const api = makeApi({
      readRbacPolicy: vi.fn(async () => ({
        enforced: true,
        roles: [...BUILT_IN_ROLES],
        attachments: [],
        permissionCatalog: MESSAGING_PERMISSION_CATALOG,
        failClosed: true,
      })),
    });
    render(<AccessControlSettings desktopApi={api} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Stored policy could not be read/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/every messaging actor is denied/i),
    ).toBeInTheDocument();
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
