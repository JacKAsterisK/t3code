import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { SidebarBrandMark } from "./SidebarBrandMark";

const client = vi.hoisted(() => ({ version: "unknown" }));
vi.mock("../../clientBuildVersion", () => ({
  get CLIENT_FORK_BUILD_VERSION() {
    return client.version;
  },
}));

it.each(["v7.8.9", "dev", "unknown"])(
  "shows the client fork build beside the brand with readable context: %s",
  async (version) => {
    client.version = version;
    await using screen = await render(<SidebarBrandMark onBackdrop={false} />);
    await expect.element(screen.getByText("Code", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(version, { exact: true })).toBeVisible();
    expect(screen.container.textContent).toContain(`Client fork build: ${version}`);

    await screen.rerender(<SidebarBrandMark onBackdrop />);
    await expect.element(screen.getByText(version, { exact: true })).toBeVisible();
  },
);
