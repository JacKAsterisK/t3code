import type { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentCatalog } from "../../connection/catalog";
import {
  AuthSessionId,
  EnvironmentId,
  LanFleetError,
  WS_METHODS,
  type LanFleetResetInput,
  type LanFleetResetPreview,
  type LanFleetResetReceipt,
  type LanFleetSetupState,
  type LanFleetSyncInput,
  type LanFleetSyncResult,
} from "@t3tools/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
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
  reset:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: LanFleetResetInput;
      }) => LanFleetResetPreview | LanFleetResetReceipt | LanFleetError
    >(),
  remove: vi.fn(),
  useLanFleet: vi.fn(),
  setup: vi.fn<() => LanFleetSetupState>(),
  configure: vi.fn<(input: unknown) => LanFleetSetupState>(),
  sync: vi.fn<(input: LanFleetSyncInput) => LanFleetSyncResult>(),
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
      const action =
        options.tag === "server.syncLanFleet"
          ? (input: LanFleetSyncInput) => fixtures.sync(input)
          : options.tag === "server.getLanFleetSetup"
            ? () => fixtures.setup()
            : options.tag === "server.configureLanFleet"
              ? (input: unknown) => fixtures.configure(input)
              : undefined;
      if (action !== undefined)
        return {
          label: options.label,
          permissionAtom: () => Atom.make(true),
          run: (_registry: unknown, { input }: { input: LanFleetSyncInput }) =>
            Effect.sync(() => action(input)),
        };
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
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
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
vi.mock(import("../../environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: (() => ({
    source: "desktop-managed",
    target: { httpBaseUrl: "http://127.0.0.1:3773/", wsBaseUrl: "ws://127.0.0.1:3773/" },
  })) as never,
}));

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
    route("Current fleet route", fleetId, true),
    route("Unpinned current route", fleetId),
    route("Legacy pin route", undefined, true),
    route("Manual route"),
    route("Other fleet route", "other-fleet", true),
  ];
  const registry = appAtomRegistry;
  const setRoutes = (routes: ReadonlyArray<ConnectionCatalogEntry>) => {
    const atom = environmentCatalog.catalogValueAtom;
    registry.set(atom as Atom.Writable<Atom.Type<typeof atom>>, {
      ...registry.get(atom),
      entries: new Map(routes.map((entry) => [entry.target.environmentId, entry])),
    });
  };
  setRoutes(entries);
  fixtures.useLanFleet.mockReturnValue({
    environmentId,
    allowed: true,
    summary: null,
    setup: { stage: "active" } satisfies Partial<LanFleetSetupState>,
    busy: false,
  });
  fixtures.reset.mockReset();
  fixtures.remove.mockReset();
  return { environmentId, preview, receipt, registry, setRoutes, entries, route };
}

it("Link both ways reports saved environments including legacy unpinned fleet routes", async () => {
  const { environmentId, registry, route, setRoutes } = setup();
  const manual = route("Manual connection");
  const savedFleet = route("Legacy unpinned fleet connection");
  const peer = {
    machineId: "fixture-peer",
    environmentId: manual.target.environmentId,
    label: "Fixture peer",
  };
  const setupState: LanFleetSetupState = {
    available: true,
    stage: "active",
    owner: true,
    ownerCode: null,
    deviceCode: null,
    environmentId,
    label: "Fixture owner",
    origin: "https://fixture-owner.example.test",
    autoPickup: true,
    access: "standard",
    peers: [
      {
        ...peer,
        origin: "https://fixture-peer.example.test",
        verificationCode: "123456789012",
        status: "approved",
      },
    ],
  };
  const { useLanFleet } = await vi.importActual<typeof import("../../connection/lanFleet")>(
    "../../connection/lanFleet",
  );
  fixtures.useLanFleet.mockImplementation(useLanFleet);
  fixtures.setup.mockReset().mockReturnValue(setupState);
  fixtures.configure.mockReset().mockReturnValue(setupState);
  fixtures.sync.mockReset().mockReturnValue({
    enabled: true,
    autoPickup: true,
    machines: [{ ...peer, status: "pending" }],
    incoming: [],
  });
  setRoutes([
    {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Fixture owner",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
      enabled: true,
      profile: Option.none(),
    },
    manual,
    savedFleet,
  ]);
  vi.stubGlobal("desktopBridge", {
    getClientPlatform: () => "win32",
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    ],
  });
  try {
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <LanFleetSettings />
      </RegistryContext.Provider>,
    );
    await screen.getByRole("button", { name: "Sync now" }).click();
    await screen.getByRole("button", { name: "Link both ways" }).click();
    await vi.waitFor(() => expect(fixtures.sync).toHaveBeenCalledTimes(2));
    expect(fixtures.configure).toHaveBeenCalledExactlyOnceWith({
      operation: "link",
      confirmed: true,
      machineIds: [peer.machineId],
    });
    expect(fixtures.sync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "manual",
        sendMachineIds: [],
        connectedEnvironmentIds: [
          environmentId,
          manual.target.environmentId,
          savedFleet.target.environmentId,
        ],
        pinnedFleetRoutes: [],
        completedReplacementDeliveryIds: [],
      }),
    );
    expect(fixtures.sync.mock.lastCall?.[0]).not.toHaveProperty("fleetConnectedEnvironmentIds");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reviews a fleet reset, refuses stale review, and removes saved routes only when included", async () => {
  const { environmentId, preview, receipt, registry, setRoutes, entries, route } = setup();
  const newPreview = { ...preview, digest: "b".repeat(64) };
  const stale = new LanFleetError({ reason: "configuration", refusal: "stale-review" });
  fixtures.reset
    .mockImplementationOnce(() => {
      setRoutes([...entries, route("Route added during preview", preview.fleetId, true)]);
      return preview;
    })
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
  await expect
    .element(page.getByText(/1 outgoing state entries and 2 peers with serving state or sessions/))
    .toBeVisible();
  await expect.element(page.getByText(/Current fleet route/)).toBeVisible();
  await expect.element(page.getByText(/Route added during preview/)).toBeVisible();
  await expect.element(page.getByText(/Legacy pin route/)).toBeVisible();
  await expect
    .element(page.getByText(/Manual route|Other fleet route|Unpinned current route/))
    .not.toBeInTheDocument();
  await expect.element(include).not.toBeChecked();
  expect(fixtures.reset).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { mode: "preview" },
  });

  await include.click();
  await confirm.click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Fleet links changed. Review the current list before resetting.");
  expect(fixtures.reset).toHaveBeenNthCalledWith(2, {
    environmentId,
    input: {
      mode: "apply",
      fleetId: preview.fleetId,
      previewDigest: preview.digest,
    },
  });
  expect(fixtures.remove).not.toHaveBeenCalled();

  setRoutes(entries);
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
        expectedFleet: {
          fleetId: preview.fleetId,
          fleetTls: expect.objectContaining({ origin: "https://current-fleet-route.example.test" }),
        },
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
