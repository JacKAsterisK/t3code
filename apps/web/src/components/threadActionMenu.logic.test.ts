import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const FLEET_USERS = [
  { id: "dan", name: "Dan" },
  { id: "gavin", name: "Gavin" },
];

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
        owner: { ownerId: "dan", users: FLEET_USERS },
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
      // Read-only sessions may still set an owner, so assigning stays enabled.
      expect(items.find((item) => item.id === "owner")?.children).toEqual([
        { id: "owner:dan", label: "Dan", checked: true },
        { id: "owner:gavin", label: "Gavin", checked: false },
      ]);
      expect(threadActionRequiresOperate("owner:gavin")).toBe(false);
    },
  );

  it("offers Assign to only when the fleet has users", () => {
    const ids = (owner: ThreadActionMenuState["owner"]) =>
      buildThreadActionMenuItems({ ...baseState, ...(owner ? { owner } : {}) }).map(
        (item) => item.id,
      );
    expect(ids(undefined)).not.toContain("owner");
    expect(ids({ ownerId: null, users: [] })).not.toContain("owner");
    expect(ids({ ownerId: null, users: FLEET_USERS })).toContain("owner");
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
