// Mounts the whole app on a fleet whose threads have owners, as ReadOnlyMachine.browser.test.tsx
// does: owner badges, the sidebar's owner filter, and reassigning, read-only machines included.
import { createMemoryHistory } from "@tanstack/react-router";
import {
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  type FleetUsersDirectory,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { environmentCatalog } from "~/connection/catalog";
import { connectPairing } from "~/connection/onboarding";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ENVIRONMENT_ID,
  REMOTE_ENVIRONMENT_ID,
  REMOTE_ORIGIN,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const DANS = { ...threadWithHistory("owned-dan", 1), ownerId: "dan" };
const GAVINS = { ...threadWithHistory("owned-gavin", 1), ownerId: "gavin" };
const FLEET_USERS: FleetUsersDirectory = {
  users: [
    { id: "dan", name: "Dan", color: "sky" },
    { id: "gavin", name: "Gavin" },
  ],
  machineId: "anviltoad",
  defaultOwnerId: "dan",
};
const threadPath = `/${ENVIRONMENT_ID}/${DANS.id}`;
const fleetRouter = () => getRouter(createMemoryHistory({ initialEntries: [threadPath] }));

// Loads the thread route's chunks while the file is collected, as ReadOnlyMachine does.
{
  using _environment = installFakeEnvironment([DANS, GAVINS]);
  await fleetRouter().load();
}

async function renderFleetApp(router: ReturnType<typeof fleetRouter>) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  // The app owns its router, as main.tsx does, so render() adds none.
  return render(<AppRoot router={router} />, { container, router: false });
}

const row = (thread: { readonly title: string }) =>
  page.getByRole("treeitem", { name: new RegExp(thread.title) });
const ownerSet = (threadId: string, ownerId: string) =>
  expect.objectContaining({ type: "thread.owner.set", threadId, ownerId });

it("badges each row with its owner and filters the sidebar to Mine or Everyone", async () => {
  using _environment = installFakeEnvironment([DANS, GAVINS], { fleetUsers: FLEET_USERS });
  await using _app = await renderFleetApp(fleetRouter());
  await expect.element(page.getByText(`Answer 0 for ${DANS.id}.`)).toBeVisible();

  const dansBadge = row(DANS).getByRole("button", { name: "Managed by Dan" });
  await expect.element(dansBadge).toHaveTextContent("D");
  await expect.element(row(GAVINS).getByRole("button", { name: "Managed by Gavin" })).toBeVisible();

  await page.getByLabelText(/^Filter threads by project/).click();
  const ownerFilter = page.getByRole("group", { name: "Show threads managed by" });
  await ownerFilter.getByRole("button", { name: "Mine" }).click();
  await expect.element(row(GAVINS)).not.toBeInTheDocument();
  await expect.element(row(DANS)).toBeVisible();

  await ownerFilter.getByRole("button", { name: "Everyone" }).click();
  await expect.element(row(GAVINS)).toBeVisible();
});

it("reassigns a thread from its badge", async () => {
  using _environment = installFakeEnvironment([DANS, GAVINS], { fleetUsers: FLEET_USERS });
  await using _app = await renderFleetApp(fleetRouter());
  const gavinsBadge = row(GAVINS).getByRole("button", { name: "Managed by Gavin" });
  await expect.element(gavinsBadge).toBeVisible();

  await gavinsBadge.click();
  await page.getByRole("menuitemradio", { name: "Dan" }).click();
  await vi.waitFor(() => expect(dispatchedCommands()).toContainEqual(ownerSet(GAVINS.id, "dan")));
  // Clicking the badge opened its menu without opening the thread.
  await expect.element(page.getByText(`Answer 0 for ${DANS.id}.`)).toBeVisible();
});

it("lets a read-only machine's thread be reassigned from the thread header", async () => {
  // What a fleet machine with read-only access is issued.
  using _environment = installFakeEnvironment([DANS, GAVINS], {
    remoteScopes: [AuthOrchestrationReadScope, AuthFilesystemReadScope, AuthDiagnosticsReadScope],
    fleetUsers: FLEET_USERS,
  });
  const router = fleetRouter();
  await using _app = await renderFleetApp(router);
  await expect.element(page.getByText(`Answer 0 for ${DANS.id}.`)).toBeVisible();
  // Pairing saves the machine in this browser's storage, which other test files share.
  await using _paired = new AsyncDisposableStack();
  _paired.defer(async () => {
    await environmentCatalog.remove.run(appAtomRegistry, REMOTE_ENVIRONMENT_ID);
  });
  const paired = await connectPairing.run(appAtomRegistry, {
    host: REMOTE_ORIGIN,
    pairingCode: "remote-pairing-code",
    expectedEnvironmentId: REMOTE_ENVIRONMENT_ID,
  });
  expect(paired._tag).toBe("Success");

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: REMOTE_ENVIRONMENT_ID, threadId: GAVINS.id },
    }),
  );
  await expect
    .element(page.getByTestId("composer-editor"))
    .toHaveAttribute("aria-readonly", "true");
  const header = page.getByLabelText("Thread breadcrumb");
  await header.getByRole("button", { name: "Managed by Gavin" }).click();
  await page.getByRole("menuitemradio", { name: "Dan" }).click();
  await vi.waitFor(() => expect(dispatchedCommands()).toContainEqual(ownerSet(GAVINS.id, "dan")));
});
