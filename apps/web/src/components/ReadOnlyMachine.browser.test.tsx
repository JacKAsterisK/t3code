// Mounts the whole app, as test/appScenarios.renders.tsx does, then pairs a second machine
// whose session may only read, such as a fleet machine set to read-only access.
import { createMemoryHistory } from "@tanstack/react-router";
import {
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { openCommandPalette } from "~/commandPaletteBus";
import { environmentCatalog } from "~/connection/catalog";
import { connectPairing } from "~/connection/onboarding";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ENVIRONMENT_ID,
  REMOTE_ENVIRONMENT_ID,
  REMOTE_ORIGIN,
  REMOTE_PROJECT_TITLE,
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

const THREAD = threadWithHistory("thread-shared", 2);
const READ_ONLY_PLACEHOLDER = "Read only: you can view this thread but not send to it.";
const threadPath = (environmentId: string) => `/${environmentId}/${THREAD.id}`;

// A first mount loads the thread route's chunks, which on a loaded machine take most of a
// test's 15 seconds. Loading them while this file is collected keeps that out of the tests.
{
  using _environment = installFakeEnvironment([THREAD]);
  await getRouter(createMemoryHistory({ initialEntries: [threadPath(ENVIRONMENT_ID)] })).load();
}

it.each([
  // What a fleet machine with read-only access is issued.
  {
    access: "read-only",
    scopes: [AuthOrchestrationReadScope, AuthFilesystemReadScope, AuthDiagnosticsReadScope],
  },
  { access: "standard", scopes: AuthStandardClientScopes },
])("shows a $access machine and whether work can start or be sent there", async (machine) => {
  const readOnly = machine.access === "read-only";
  using _environment = installFakeEnvironment([THREAD], { remoteScopes: machine.scopes });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarThreadGrouping: "machine",
  });
  await page.viewport(1400, 900);
  const router = getRouter(createMemoryHistory({ initialEntries: [threadPath(ENVIRONMENT_ID)] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  // The app owns its router, as main.tsx does, so render() adds none.
  await using _app = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(page.getByText(`Answer 1 for ${THREAD.id}.`)).toBeVisible();

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

  // The sidebar marks the machine and offers a new thread there only if it can take one.
  const newThreadThere = page.getByRole("button", { name: "New thread on Remote machine" });
  await expect.element(page.getByText("Remote machine", { exact: true })).toBeVisible();
  if (readOnly) {
    await expect.element(page.getByText("Read only", { exact: true })).toBeVisible();
    await expect.element(newThreadThere).not.toBeInTheDocument();
  } else {
    await expect.element(newThreadThere).toBeInTheDocument();
    await expect.element(page.getByText("Read only", { exact: true })).not.toBeInTheDocument();
  }

  // So does the command palette.
  openCommandPalette({ open: "new-thread-in" });
  await expect.element(page.getByRole("option", { name: /^render/ })).toBeVisible();
  const remoteProject = page.getByRole("option", { name: new RegExp(REMOTE_PROJECT_TITLE) });
  if (readOnly) await expect.element(remoteProject).not.toBeInTheDocument();
  else await expect.element(remoteProject).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByPlaceholder("Search...")).not.toBeInTheDocument();

  // Its threads open for reading; a read-only machine's composer is locked and says why.
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: REMOTE_ENVIRONMENT_ID, threadId: THREAD.id },
    }),
  );
  const editor = page.getByTestId("composer-editor");
  if (readOnly) {
    await expect.element(editor).toHaveAttribute("aria-placeholder", READ_ONLY_PLACEHOLDER);
    await expect.element(editor).toHaveAttribute("aria-readonly", "true");
  } else {
    await expect.element(editor).not.toHaveAttribute("aria-readonly");
    await expect.element(editor).not.toHaveAttribute("aria-placeholder", READ_ONLY_PLACEHOLDER);
  }
});
