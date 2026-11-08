import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function claudeAccount(input: {
  readonly instanceId: string;
  readonly displayName: string;
  readonly email: string;
  readonly limitsCheckedAt: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: input.displayName,
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated", email: input.email },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: input.limitsCheckedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 30,
          windowDurationMins: 300,
          resetsAt: "2026-10-25T18:00:00.000Z",
        },
      ],
    },
  };
}

describe("UsageLimitsPooled stale readings", () => {
  it("names only accounts whose last reading is old, without their e-mail", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              claudeAccount({
                instanceId: "claude_work",
                displayName: "Claude Work",
                email: "work@example.com",
                limitsCheckedAt: "2026-10-25T14:00:00.000Z",
              }),
            ],
          },
        },
      ],
      [
        EnvironmentId.make("laptop"),
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: {
            providers: [
              claudeAccount({
                instanceId: "claude_personal",
                displayName: "Claude Personal",
                email: "personal@example.com",
                limitsCheckedAt: "2026-10-25T15:58:00.000Z",
              }),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(
        screen.getByText(
          "Desk · Claude Work: Last checked 2h 0m ago, so these limits may be out of date.",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/Claude Personal: Last checked/)).not.toBeInTheDocument();
    await expect.element(screen.getByText(/work@example\.com/)).not.toBeInTheDocument();
  });
});
