import { AtomRegistry } from "effect/reactivity";
import {
  AuthSessionId,
  EnvironmentId,
  LanFleetError,
  WS_METHODS,
  type LanFleetResetInput,
  type LanFleetResetPreview,
  type LanFleetResetReceipt,
  type LanFleetSetupState,
} from "@t3tools/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { LanFleetSettings } from "./LanFleetSettings";

const fixtures = vi.hoisted(() => ({
  entries: new Map<EnvironmentId, ConnectionCatalogEntry>(),
  reset:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: LanFleetResetInput;
      }) => LanFleetResetPreview | LanFleetResetReceipt | LanFleetError
    >(),
  remove: vi.fn(),
  useLanFleet: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => {
  const runtime = await original();
  const Effect = await import("effect/Effect");
  const { Atom } = await import("effect/reactivity");
  return {
    ...runtime,
    createEnvironmentRpcCommand: ((
      _runtime: unknown,
      options: Parameters<typeof runtime.createEnvironmentRpcCommand>[1],
    ) => {
      if (options.tag !== "server.resetLanFleetLinks")
        return runtime.createEnvironmentRpcCommand(_runtime as never, options);
      return {
        label: options.label,
        permissionAtom: () => Atom.make(true),
        run: (_registry: unknown, input: Parameters<typeof fixtures.reset>[0]) =>
          Effect.suspend(() => {
            const result = fixtures.reset(input);
            return "_tag" in result ? Effect.fail(result) : Effect.succeed(result);
          }),
      };
    }) as typeof runtime.createEnvironmentRpcCommand,
  };
});
vi.mock(import("../../connection/catalog"), async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make(() => ({ isReady: true, entries: fixtures.entries })),
      removeRoute: {
        label: "remove-route",
        run: (_registry: unknown, input: unknown) => Effect.sync(() => fixtures.remove(input)),
      },
    } as never,
  };
});
vi.mock(import("../../connection/lanFleet"), async (original) => {
  const { useLanFleetReset } = await original();
  return { useLanFleetReset, useLanFleet: fixtures.useLanFleet };
});
vi.mock(import("./LanFleetSetup"), () => ({ LanFleetSetup: () => <></> }));

function setup() {
  const environmentId = EnvironmentId.make("fixture-local");
  const fleetId = "fixture-fleet";
  const digest = "a".repeat(64);
  const preview: LanFleetResetPreview = {
    fleetId,
    items: {
      links: [
        {
          environmentId: EnvironmentId.make("fixture-peer"),
          label: "Agent peer",
          machineId: "fixture-peer",
          linkedAt: "2026-11-25T00:00:00Z",
        },
      ],
      sessions: [
        {
          sessionId: AuthSessionId.make("fixture-session"),
          subject: "lan-fleet-peer-link:fixture-peer:fixture",
        },
      ],
      codes: [{ id: "fixture-code", subject: "lan-fleet-peer-link:fixture-other:fixture" }],
      state: { linking: 1, serving: 2 },
    },
    digest,
  };
  const receipt: LanFleetResetReceipt = {
    fleetId,
    previewDigest: digest,
    unlinked: 1,
    revokedSessions: 1,
    revokedCodes: 1,
    completedUtc: "2026-11-25T01:00:00Z",
  };
  const route = (label: string, recordedFleet?: string, pinned = false): ConnectionCatalogEntry => {
    const id = EnvironmentId.make(label.toLowerCase().replaceAll(" ", "-"));
    const origin = `https://${id}.example.test`;
    const target = new BearerConnectionTarget({
      environmentId: id,
      connectionId: `route-${id}`,
      label,
    });
    return {
      target,
      enabled: true,
      profile: Option.some(
        new BearerConnectionProfile({
          environmentId: id,
          connectionId: target.connectionId,
          label,
          httpBaseUrl: origin,
          wsBaseUrl: origin.replace("https:", "wss:"),
          ...(recordedFleet === undefined ? {} : { fleetId: recordedFleet }),
          ...(pinned
            ? { fleetTls: { origin, certificate: "fixture", publicKeySha256: "b".repeat(64) } }
            : {}),
        }),
      ),
    };
  };
  const entries = [
    route("Current fleet route", fleetId),
    route("Legacy pin route", undefined, true),
    route("Manual route"),
    route("Other fleet route", "other-fleet", true),
  ];
  const registry = AtomRegistry.make();
  fixtures.entries = new Map(entries.map((entry) => [entry.target.environmentId, entry]));
  fixtures.useLanFleet.mockReturnValue({
    environmentId,
    allowed: true,
    summary: null,
    setup: { stage: "active" } satisfies Partial<LanFleetSetupState>,
    busy: false,
  });
  fixtures.reset.mockReset();
  fixtures.remove.mockReset();
  return { environmentId, preview, receipt, registry };
}

it("reviews a fleet reset, refuses stale review, and removes saved routes only when included", async () => {
  const { environmentId, preview, receipt, registry } = setup();
  const newPreview = { ...preview, digest: "b".repeat(64) };
  const stale = new LanFleetError({ reason: "configuration", refusal: "stale-review" });
  fixtures.reset
    .mockReturnValueOnce(preview)
    .mockReturnValueOnce(stale)
    .mockReturnValueOnce(newPreview)
    .mockReturnValueOnce({ ...receipt, previewDigest: newPreview.digest })
    .mockReturnValueOnce(preview)
    .mockReturnValueOnce(receipt);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <LanFleetSettings />
    </RegistryContext.Provider>,
  );
  const open = screen.getByRole("button", { name: "Reset fleet links" });
  const confirm = page.getByRole("button", { name: "Confirm reset" });
  const include = page.getByRole("checkbox", { name: "Also remove these saved fleet connections" });

  await open.click();
  await expect.element(page.getByText(/Agent link to Agent peer/)).toBeVisible();
  await expect.element(page.getByText(/Served session fixture-session/)).toBeVisible();
  await expect.element(page.getByText(/Pending code fixture-code/)).toBeVisible();
  await expect.element(page.getByText(/1 outgoing and 2 serving/)).toBeVisible();
  await expect.element(page.getByText(/Current fleet route/)).toBeVisible();
  await expect.element(page.getByText(/Legacy pin route/)).toBeVisible();
  await expect.element(page.getByText(/Manual route|Other fleet route/)).not.toBeInTheDocument();
  await expect.element(include).not.toBeChecked();
  expect(fixtures.reset).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { mode: "preview" },
  });

  await include.click();
  await confirm.click();
  await expect.element(page.getByRole("alert")).toHaveTextContent(stale.message);
  expect(fixtures.reset).toHaveBeenNthCalledWith(2, {
    environmentId,
    input: {
      mode: "apply",
      fleetId: preview.fleetId,
      previewDigest: preview.digest,
    },
  });
  expect(fixtures.remove).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Review again" }).click();
  await expect.element(include).not.toBeChecked();
  await confirm.click();
  await expect.element(page.getByText("Fleet reset complete")).toBeVisible();
  expect(fixtures.reset).toHaveBeenNthCalledWith(4, {
    environmentId,
    input: {
      mode: "apply",
      fleetId: preview.fleetId,
      previewDigest: newPreview.digest,
    },
  });
  expect(fixtures.remove).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Done" }).click();
  await open.click();
  await include.click();
  await confirm.click();
  await expect.element(page.getByText("Fleet reset complete")).toBeVisible();
  expect(fixtures.remove.mock.calls).toEqual([
    [
      {
        environmentId: "current-fleet-route",
        routeId: "route-current-fleet-route",
        expectedFleet: { fleetId: preview.fleetId },
      },
    ],
    [
      {
        environmentId: "legacy-pin-route",
        routeId: "route-legacy-pin-route",
        expectedFleet: {
          fleetTls: expect.objectContaining({ origin: "https://legacy-pin-route.example.test" }),
        },
      },
    ],
  ]);
  expect(WS_METHODS.serverResetLanFleetLinks).toBe("server.resetLanFleetLinks");
});
