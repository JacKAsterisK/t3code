import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { render } from "../../../test/render";
import { SidebarBrandMark } from "./SidebarBrandMark";

vi.mock("../../clientBuildVersion", () => ({
  CLIENT_FORK_BUILD_VERSION: "v7.8.9",
}));

it("shows the compiled client fork build beside the brand with readable context", async () => {
  const version = "v7.8.9";
  await using screen = await render(<SidebarBrandMark onBackdrop={false} />);
  await expect.element(screen.getByText("Code", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(version, { exact: true })).toBeVisible();
  expect(screen.container.textContent).toContain(`Client fork build: ${version}`);

  await screen.rerender(<SidebarBrandMark onBackdrop />);
  await expect.element(screen.getByText(version, { exact: true })).toBeVisible();
});
