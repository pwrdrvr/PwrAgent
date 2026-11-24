import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  DesktopAuthorizedContact,
  DesktopTelegramConnection,
  DesktopTelegramPairingGrants,
} from "@pwragent/shared/contracts/settings";
import {
  resolveTelegramConnectionConversations,
  withOriginalTelegramEnabled,
} from "../messaging/telegram-connection-catalog";

const ORIGINAL_ACCOUNT = "111111";
const NAMED_ACCOUNT = "222222";
const NAMED_ID = `mc_${"a".repeat(32)}`;
const LEGACY_ID = `mc_${"b".repeat(32)}`;

// Deliberately shared: one group and one person authorized on both bots.
const groupId = fc.constantFrom("-1001234567890", "-1009876543210", "-1005555555555");
const userId = fc.constantFrom("42", "77", "1001");
const contact = (id: fc.Arbitrary<string>) =>
  fc.record({ id, displayName: fc.constantFrom("", "Orchard Ops", "Dana") });
const contacts = (id: fc.Arbitrary<string>) => fc.array(contact(id), { maxLength: 4 });

function grants(
  accountId: string,
  supergroups: DesktopAuthorizedContact[],
  users: DesktopAuthorizedContact[],
): DesktopTelegramPairingGrants {
  return { accountId, supergroups, users };
}

function connection(overrides: Partial<DesktopTelegramConnection>): DesktopTelegramConnection {
  return {
    id: NAMED_ID,
    displayName: "Orchard bot",
    botAccountId: NAMED_ACCOUNT,
    enabled: true,
    legacy: false,
    authorizedUserIds: [],
    authorizedSupergroupIds: [],
    ...overrides,
  };
}

describe("resolveTelegramConnectionConversations", () => {
  it("lists a named bot's own audience and never the original bot's", () => {
    fc.assert(fc.property(
      contacts(groupId), contacts(userId), contacts(groupId), contacts(userId),
      fc.array(groupId, { maxLength: 3 }), fc.array(userId, { maxLength: 3 }),
      (originalGroups, originalUsers, namedGroups, namedUsers, configuredGroups, configuredUsers) => {
        const named = connection({
          authorizedSupergroupIds: [...new Set(configuredGroups)],
          authorizedUserIds: [...new Set(configuredUsers)],
        });
        const result = resolveTelegramConnectionConversations({
          connectionId: NAMED_ID,
          connections: [connection({ id: LEGACY_ID, legacy: true, botAccountId: ORIGINAL_ACCOUNT }), named],
          original: {
            supergroups: originalGroups,
            users: originalUsers,
            grants: grants(ORIGINAL_ACCOUNT, originalGroups, originalUsers),
          },
          readNamedGrants: () => grants(NAMED_ACCOUNT, namedGroups, namedUsers),
        });
        // Oracle: exactly the named bot's configured IDs plus its grants.
        const expectedGroups = new Set([...configuredGroups, ...namedGroups.map((entry) => entry.id)]);
        const expectedUsers = new Set([...configuredUsers, ...namedUsers.map((entry) => entry.id)]);
        expect(result.status).toBe("available");
        expect(new Set(result.supergroups.map((entry) => entry.id))).toEqual(expectedGroups);
        expect(new Set(result.users.map((entry) => entry.id))).toEqual(expectedUsers);
        expect(result.supergroups).toHaveLength(expectedGroups.size);
        expect(result.users).toHaveLength(expectedUsers.size);
      },
    ));
  });

  it("lists nothing for a removed, disabled or stopped named bot", () => {
    fc.assert(fc.property(
      fc.constantFrom("missing", "disabled", "offline", "other-account"),
      contacts(groupId),
      (state, originalGroups) => {
        const named = connection({ enabled: state !== "disabled" });
        const result = resolveTelegramConnectionConversations({
          connectionId: NAMED_ID,
          connections: state === "missing" ? [] : [named],
          original: { supergroups: originalGroups, users: [] },
          readNamedGrants: () => state === "offline"
            ? undefined
            : grants(state === "other-account" ? ORIGINAL_ACCOUNT : NAMED_ACCOUNT, originalGroups, []),
        });
        expect(result.supergroups).toEqual([]);
        expect(result.users).toEqual([]);
        expect(result.status).toBe(
          state === "other-account" ? "offline" : state,
        );
      },
    ));
  });

  it("keeps the original route's settings list and adds its pairing grants", () => {
    fc.assert(fc.property(contacts(groupId), contacts(groupId), fc.boolean(), (configured, granted, migrated) => {
      const result = resolveTelegramConnectionConversations({
        connections: migrated ? [connection({ id: LEGACY_ID, legacy: true })] : undefined,
        original: { supergroups: configured, users: [], grants: grants(ORIGINAL_ACCOUNT, granted, []) },
        readNamedGrants: () => {
          throw new Error("the original route never reads a named store");
        },
      });
      expect(result.status).toBe("available");
      expect(result.supergroups.map((entry) => entry.id)).toEqual([
        ...new Set([...configured, ...granted].map((entry) => entry.id)),
      ]);
    }));
  });

  it("judges the original route by its setting, not the row copied at migration", () => {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.constantFrom("config", "default", "env"), fc.boolean(),
      (rowEnabled, settingEnabled, source, namedEnabled) => {
        const named = connection({ enabled: namedEnabled });
        const connections = withOriginalTelegramEnabled(
          [connection({ id: LEGACY_ID, legacy: true, enabled: rowEnabled }), named],
          { value: settingEnabled, source },
        );
        // Oracle: the runtime starts the original bot from the setting, and
        // from the row only when the environment sets it.
        const runs = source === "env" ? rowEnabled : settingEnabled;
        expect(connections?.find((row) => row.legacy)?.enabled).toBe(runs);
        expect(connections?.find((row) => !row.legacy)).toEqual(named);
        const result = resolveTelegramConnectionConversations({
          connections,
          original: { supergroups: [{ id: "-1001234567890", displayName: "Orchard Ops" }], users: [] },
          readNamedGrants: () => grants(NAMED_ACCOUNT, [], []),
        });
        expect(result.status).toBe(runs ? "available" : "disabled");
      },
    ));
    expect(withOriginalTelegramEnabled(undefined, { value: true, source: "config" })).toBeUndefined();
  });

  it("reports the original route missing when the profile has only named bots", () => {
    const result = resolveTelegramConnectionConversations({
      connections: [connection({})],
      original: { supergroups: [{ id: "-1001234567890", displayName: "Orchard Ops" }], users: [] },
      readNamedGrants: () => grants(NAMED_ACCOUNT, [], []),
    });
    expect(result).toEqual({ status: "missing", supergroups: [], users: [] });
  });
});
