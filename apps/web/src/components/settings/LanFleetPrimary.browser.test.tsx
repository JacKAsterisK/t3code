import { EnvironmentId } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  catalogKey: {},
  catalog: { entries: new Map() },
  desktop: true,
  distro: null as string | null,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => (atom === state.catalogKey ? state.catalog : null)) as never,
}));
vi.mock(import("../../connection/catalog"), async () => {
  const { Atom } = await import("effect/reactivity");
  // Upstream primary-environment state reads this atom before React renders.
  state.catalogKey = Atom.make(() => state.catalog);
  return { environmentCatalog: { catalogValueAtom: state.catalogKey } as never };
});
vi.mock(import("../../environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: (() =>
    state.desktop
      ? {
          source: "desktop-managed",
          target: { httpBaseUrl: "http://127.0.0.1:3773/", wsBaseUrl: "ws://127.0.0.1:3773/" },
        }
      : { source: "window-origin" }) as never,
}));

import { LanFleetSettings } from "./LanFleetSettings";

it("shows LAN machine links for the desktop's primary local environment", async () => {
  const environmentId = EnvironmentId.make("desktop-primary");
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "This machine",
    httpBaseUrl: "http://127.0.0.1:3773/",
    wsBaseUrl: "ws://127.0.0.1:3773/",
  });
  state.catalog = { entries: new Map([[environmentId, { target }]]) };
  state.desktop = true;
  state.distro = null;
  vi.stubGlobal("desktopBridge", {
    getClientPlatform: () => "win32",
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        runningDistro: state.distro,
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    ],
  });
  await using screen = await render(<LanFleetSettings />);
  await expect.element(screen.getByText("LAN machine links", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Check fleet setup" })).toBeVisible();
});

it("does not show the LAN host controls for a browser primary", async () => {
  const environmentId = EnvironmentId.make("browser-primary");
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Browser server",
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
  });
  state.catalog = { entries: new Map([[environmentId, { target }]]) };
  state.desktop = false;
  await using screen = await render(<LanFleetSettings />);
  await expect
    .element(screen.getByText("LAN machine links", { exact: true }))
    .not.toBeInTheDocument();
});

it("does not show Windows LAN host controls for a WSL primary", async () => {
  const environmentId = EnvironmentId.make("wsl-primary");
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "WSL",
    httpBaseUrl: "http://127.0.0.1:3773/",
    wsBaseUrl: "ws://127.0.0.1:3773/",
  });
  state.catalog = { entries: new Map([[environmentId, { target }]]) };
  state.desktop = true;
  state.distro = "Ubuntu";
  vi.stubGlobal("desktopBridge", {
    getClientPlatform: () => "win32",
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        runningDistro: state.distro,
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    ],
  });
  await using screen = await render(<LanFleetSettings />);
  await expect
    .element(screen.getByText("LAN machine links", { exact: true }))
    .not.toBeInTheDocument();
});
