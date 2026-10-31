// @effect-diagnostics nodeBuiltinImport:off -- This standalone launcher owns and tracks only its focused test subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
const phaseAt = args.indexOf("--phase");
const phase = phaseAt === -1 ? "transport" : args[phaseAt + 1];
if (
  phase !== "transport" &&
  phase !== "approvals" &&
  phase !== "facts" &&
  phase !== "compatibility" &&
  phase !== "fleet"
)
  throw new Error(
    "Use --phase transport, --phase approvals, --phase facts, --phase compatibility or --phase fleet.",
  );
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-approval-harness-"));
const report = NodePath.join(scratch, "results.json");
const files =
  phase === "fleet"
    ? [
        "apps/server/src/approvals/ApprovalFleetHarness.test.ts",
        "apps/server/src/approvals/ApprovalForwarding.test.ts",
        "apps/server/src/auth/ApprovalPeerAccess.test.ts",
      ]
    : phase === "compatibility"
      ? [
          "apps/server/src/agentEvents/AgentFactDeriver.test.ts",
          "apps/server/src/agentEvents/AgentFactStore.test.ts",
          "apps/server/src/agentEvents/AgentFactReplay.test.ts",
          "apps/server/src/agentEvents/AgentFactRetention.test.ts",
          "apps/server/src/agentEvents/AgentGatewayCompatibilityFacts.test.ts",
          "apps/server/src/lan/GatewayCompatibilityManifest.test.ts",
          "apps/server/src/cli/agentEventsCompatibility.test.ts",
          "apps/server/src/lan/RoutingStore.test.ts",
          "apps/server/src/lan/EnvironmentRouting.test.ts",
          "apps/server/src/lan/NativeTaskService.test.ts",
          "apps/server/src/persistence/Migrations/086_AgentGatewayCompatibility.test.ts",
        ]
      : phase === "transport"
        ? ["apps/server/src/agentEvents/AgentEventsHarness.test.ts"]
        : phase === "facts"
          ? [
              "apps/server/src/agentEvents/AgentFactDeriver.test.ts",
              "apps/server/src/agentEvents/AgentFactDeliveryHarness.test.ts",
              "apps/server/src/orchestration-v2/FoundationPersistence.test.ts",
              "apps/server/src/agentEvents/AgentFactReducer.test.ts",
              "apps/server/src/agentEvents/AgentFactStore.test.ts",
              "apps/server/src/agentEvents/AgentFactReplay.test.ts",
              "apps/server/src/agentEvents/AgentFactRetention.test.ts",
              "apps/server/src/agentEvents/AgentGatewayCompatibilityFacts.test.ts",
              "apps/server/src/agentEvents/AgentFactAuthority.test.ts",
              "apps/server/src/agentEvents/AgentEventSourceCapture.test.ts",
              "apps/server/src/agentEvents/AgentEventOwnerJournal.test.ts",
              "apps/server/src/agentEvents/AgentEventDelivery.test.ts",
              "apps/server/src/agentEvents/AgentEventSubscriptions.test.ts",
              "apps/server/src/mcp/events/McpEventsEndpoint.test.ts",
              "apps/server/src/lan/FleetUsers.test.ts",
              "apps/server/src/persistence/Migrations/083_AgentEventFacts.test.ts",
            ]
          : [
              "apps/server/src/approvals/ApprovalService.test.ts",
              "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
              "apps/server/src/auth/McpOAuth.test.ts",
              "apps/server/src/auth/EnvironmentAuth.test.ts",
              "apps/server/src/persistence/Migrations/082_AgentApprovalAuthorityAndReceipts.test.ts",
              "packages/contracts/src/approvals.test.ts",
              "packages/shared/src/approvalPresentation.test.ts",
              "packages/effect-codex-app-server/src/node.test.ts",
              "packages/effect-codex-app-server/src/client.test.ts",
              "packages/effect-codex-app-server/src/protocol.test.ts",
              "packages/effect-codex-app-server/src/_internal/stdio.test.ts",
              "packages/effect-codex-app-server/src/permissions.test.ts",
            ];
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(root, "node_modules/vite-plus/bin/vp"),
    "test",
    "run",
    ...files,
    "--maxWorkers",
    "1",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, T3CODE_DEV_SEED: "0", T3CODE_HOME: scratch },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const pid = child.pid;
process.stdout.write(
  JSON.stringify({ type: "process_started", phase, pid, disposableHome: scratch, seeded: false }) +
    "\n",
);
let diagnostics = "";
let outputLine = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk: string) => {
    diagnostics = (diagnostics + chunk).slice(-32_000);
    outputLine += chunk;
    const lines = outputLine.split(/\r?\n/u);
    outputLine = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith('{"proof"')) process.stdout.write(line + "\n");
  });
const stop = () => {
  if (child.exitCode === null && child.signalCode === null && child.pid === pid) child.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  const reportText = await NodeFSP.readFile(report, "utf8").catch((error: unknown) => {
    process.stderr.write(diagnostics);
    throw error;
  });
  const results = JSON.parse(reportText) as {
    numPassedTests: number;
    numFailedTests: number;
    testResults: Array<{
      name: string;
      status: string;
      message?: string;
      assertionResults?: Array<{ title: string; failureMessages: string[] }>;
    }>;
  };
  for (const result of results.testResults)
    process.stdout.write(
      JSON.stringify({
        type: "suite",
        phase,
        file: result.name,
        status: result.status,
        ...(result.status === "failed"
          ? {
              detail: result.message,
              failures: result.assertionResults?.filter(
                (assertion) => assertion.failureMessages.length > 0,
              ),
            }
          : {}),
      }) + "\n",
    );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      phase,
      pid,
      exitCode: code,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      profile: phase === "approvals" ? "codex-permissions-687a119f-v1@0.159.0" : undefined,
      liveCredentials: false,
      paidProviderSessions: false,
    }) + "\n",
  );
  if (code !== 0) process.stderr.write(diagnostics);
  process.exitCode = code;
} finally {
  stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (
    NodePath.dirname(NodePath.resolve(scratch)) === NodePath.resolve(NodeOS.tmpdir()) &&
    scratch.includes("t3-agent-approval-harness-")
  )
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  else {
    process.stderr.write("Unexpected disposable harness path; cleanup withheld.\n");
    process.exitCode = 1;
  }
}
