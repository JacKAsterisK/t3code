// @effect-diagnostics nodeBuiltinImport:off -- The fake native peer spawns a real tool descendant to verify session-owned process-tree cleanup.
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";

let nextServerRequestId = 10_000;
let pendingSkillsListRequestId: number | string | null = null;
let pendingUserInputRequestId: number | null = null;
let pendingPermission: { clientId: number | string; nativeId: number } | undefined;

const writeMessage = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: number | string, result: unknown) => {
  writeMessage({ id, result });
};

const respondError = (id: number | string, code: number, message: string) => {
  writeMessage({
    id,
    error: {
      code,
      message,
    },
  });
};

const sendRequest = (method: string, params: unknown) => {
  const id = nextServerRequestId++;
  writeMessage({ id, method, params });
  return id;
};

const handleMethod = (message: Record<string, unknown>) => {
  const method = message.method;
  if (typeof method !== "string") {
    return;
  }

  switch (method) {
    case "initialize": {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone mock peer process has no Effect runtime.
      const platform = NodeOS.platform();
      const stderrBytes = Number(process.env.CODEX_APP_SERVER_TEST_STDERR_BYTES ?? 0);
      if (Number.isFinite(stderrBytes) && stderrBytes > 0) {
        process.stderr.write("x".repeat(stderrBytes), () => {
          respond(message.id as number | string, {
            userAgent:
              process.env.CODEX_APP_SERVER_TEST_PERMISSION_PROFILE === "1"
                ? "Codex/0.159.0"
                : "mock-codex-app-server",
            codexHome: process.cwd(),
            platformFamily: platform === "win32" ? "windows" : "unix",
            platformOs: platform === "darwin" ? "macos" : platform,
          });
        });
        return;
      }
      respond(message.id as number | string, {
        userAgent:
          process.env.CODEX_APP_SERVER_TEST_PERMISSION_PROFILE === "1"
            ? "Codex/0.159.0"
            : "mock-codex-app-server",
        codexHome: process.cwd(),
        platformFamily: platform === "win32" ? "windows" : "unix",
        platformOs: platform === "darwin" ? "macos" : platform,
      });
      return;
    }
    case "thread/start": {
      const thread = {
        id: "thread-approval-harness",
        sessionId: "thread-approval-harness",
        projectId: null,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 1,
        status: { type: "idle" },
        path: null,
        cwd: process.cwd(),
        cliVersion: "0.159.0",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      };
      respond(message.id as number | string, {
        thread,
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: process.cwd(),
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        reasoningEffort: "medium",
      });
      return;
    }
    case "turn/start": {
      const turn = {
        id: "turn-approval-harness",
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      };
      respond(message.id as number | string, { turn });
      writeMessage({
        method: "turn/started",
        params: { threadId: "thread-approval-harness", turn },
      });
      return;
    }
    case "test/spawnChild": {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      child.on("error", () =>
        respondError(message.id as number | string, -32000, "fixture spawn failed"),
      );
      child.once("spawn", () => respond(message.id as number | string, { pid: child.pid }));
      return;
    }
    case "test/permission": {
      pendingPermission = {
        clientId: message.id as number | string,
        nativeId: sendRequest("item/permissions/requestApproval", message.params),
      };
      return;
    }
    case "initialized": {
      writeMessage({
        method: "item/agentMessage/delta",
        params: {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      return;
    }
    case "account/read": {
      respond(message.id as number | string, {
        account: {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      });
      return;
    }
    case "skills/list": {
      pendingSkillsListRequestId = message.id as number | string;
      pendingUserInputRequestId = sendRequest("item/tool/requestUserInput", {
        isBlocking: true,
        itemId: "item-approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [
          {
            id: "approved",
            header: "Approve",
            question: "Continue with the mock skills request?",
            options: [
              {
                label: "yes",
                description: "Approve the request",
              },
            ],
          },
        ],
      });
      return;
    }
    default: {
      if (message.id !== undefined) {
        respondError(message.id as number | string, -32601, `Unhandled request: ${method}`);
      }
    }
  }
};

const handleResponse = (message: Record<string, unknown>) => {
  if (pendingPermission !== undefined && message.id === pendingPermission.nativeId) {
    respond(pendingPermission.clientId, { nativeResponse: message.result });
    pendingPermission = undefined;
    return;
  }

  if (message.id !== pendingUserInputRequestId) {
    return;
  }

  pendingUserInputRequestId = null;

  respond(pendingSkillsListRequestId!, {
    data: [
      {
        cwd: process.cwd(),
        errors: [],
        skills: [],
      },
    ],
  });
  pendingSkillsListRequestId = null;
};

let remainder = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const message = JSON.parse(trimmed) as Record<string, unknown>;
    if ("method" in message) {
      handleMethod(message);
      continue;
    }
    if ("id" in message) {
      handleResponse(message);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
