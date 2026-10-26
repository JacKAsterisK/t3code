import { EnvironmentId } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  catalogKey: {},
  catalog: { entries: new Map() },
  desktop: true,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => (atom === state.catalogKey ? state.catalog : null)) as never,
}));
vi.mock(import("../../connection/catalog"), () => ({
  environmentCatalog: { catalogValueAtom: state.catalogKey } as never,
}));
vi.mock(import("../../environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: (() =>
    state.desktop ? { source: "desktop-managed" } : { source: "window-origin" }) as never,
}));

import { LanFleetSettings } from "./LanFleetSettings";

it("shows LAN machine links for the desktop's primary local environment", async () => {
  const environmentId = EnvironmentId.make("desktop-primary");
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "This machine",
    httpBaseUrl: "http://127.0.0.1:3773",
    wsBaseUrl: "ws://127.0.0.1:3773",
  });
  state.catalog = { entries: new Map([[environmentId, { target }]]) };
  state.desktop = true;
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
