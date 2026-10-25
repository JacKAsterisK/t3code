import { EnvironmentId, type LanFleetSetupState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import type { useLanFleet } from "../../connection/lanFleet";
import { LanFleetSetup } from "./LanFleetSetup";

const mocks = vi.hoisted(() => ({ useLanFleet: vi.fn<() => ReturnType<typeof useLanFleet>>() }));
vi.mock("../../connection/lanFleet", () => ({ useLanFleet: mocks.useLanFleet }));

function setup(overrides: Partial<LanFleetSetupState> = {}) {
  mocks.useLanFleet.mockReset();
  const state: LanFleetSetupState = {
    available: true,
    stage: "unconfigured",
    owner: false,
    ownerCode: null,
    deviceCode: null,
    environmentId: EnvironmentId.make("environment-synthetic"),
    label: "Synthetic device",
    origin: "https://192.168.40.10:4443",
    managedTls: true,
    tlsEnabled: false,
    tlsReady: false,
    suggestedTlsOrigins: ["https://192.168.40.10:4443"],
    autoPickup: false,
    access: "read-only",
    peers: [],
    ...overrides,
  };
  const configure = vi.fn(async () => true);
  mocks.useLanFleet.mockReturnValue({
    environmentId: state.environmentId,
    allowed: true,
    summary: null,
    setup: state,
    error: null,
    busy: false,
    paused: false,
    pause: vi.fn(),
    run: vi.fn(async () => true),
    refreshSetup: vi.fn(async () => true),
    configure,
  });
  return { state, configure };
}

it("offers discovered LAN encryption with read-only access and no activation before confirmation", async () => {
  const { configure } = setup();
  await using screen = await render(<LanFleetSetup />);
  await screen.getByRole("button", { name: "Create fleet", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Encrypted LAN address and port" }))
    .toHaveValue("https://192.168.40.10:4443");
  await expect
    .element(page.getByRole("combobox", { name: "Fleet access scope" }))
    .toHaveTextContent("Read only");
  await expect.element(page.getByText(/opens the shown additional port/)).toBeVisible();
  expect(configure).not.toHaveBeenCalled();
  await page
    .getByRole("button", { name: "Enable encryption and create fleet", exact: true })
    .click();
  expect(configure).toHaveBeenCalledExactlyOnceWith({
    operation: "start",
    confirmed: true,
    origin: "https://192.168.40.10:4443",
    managedTls: true,
    autoPickup: true,
    access: "read-only",
  });
});

it("requires an owner code and explicit interface choice before joining a multi-interface machine", async () => {
  const { configure } = setup({
    stage: "join",
    origin: "",
    suggestedTlsOrigins: ["https://192.168.40.11:4443", "https://192.168.50.11:4443"],
  });
  await using screen = await render(<LanFleetSetup />);
  await screen.getByRole("button", { name: "Join fleet", exact: true }).click();
  const submit = page.getByRole("button", {
    name: "Enable encryption and request to join",
    exact: true,
  });
  await expect.element(submit).toBeDisabled();
  await page.getByRole("textbox", { name: "Owner verification code" }).fill("abcdef123456");
  await expect.element(submit).toBeDisabled();
  await page.getByRole("combobox", { name: "Local LAN address" }).click();
  await page.getByRole("option", { name: "https://192.168.40.11:4443", exact: true }).click();
  await expect.element(submit).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(configure).not.toHaveBeenCalled();
});
