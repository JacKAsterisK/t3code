import { expect, it } from "@effect/vitest";
import { EnvironmentId, EventId, RunId, ThreadId } from "@t3tools/contracts";
import {
  makeGatewayTaskSurface,
  observeGatewayTask,
  gatewayTaskCatalog,
  validateGatewayTaskCall,
} from "./GatewayTaskSurface.ts";

it("exports an exact task catalog and refuses excess task arguments before forwarding", async () => {
  expect(gatewayTaskCatalog()).toHaveLength(10);
  const catalog = gatewayTaskCatalog();
  catalog.pop();
  expect(gatewayTaskCatalog()).toHaveLength(10);
  expect(() =>
    validateGatewayTaskCall("t3_lan_task_read", {
      environmentId: "environment:approved",
      threadId: "thread:native",
      origin: "https://unapproved.example",
    }),
  ).toThrow();
  expect(() => validateGatewayTaskCall("t3_lan_maintenance", {})).toThrow("task_tool_required");
  let calls = 0;
  const surface = makeGatewayTaskSurface({
    authenticate: async () => true,
    client: {
      callTaskTool: async () => {
        calls++;
        return {};
      },
    },
  });
  const response = await surface(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "t3_lan_task_read",
          arguments: {
            environmentId: "environment:approved",
            threadId: "thread:native",
            origin: "https://unapproved.example",
          },
        },
      }),
    }),
  );
  expect(await response.text()).toContain("task_operation_not_confirmed");
  expect(calls).toBe(0);
});

it("authenticates before catalog or task access and exposes only native task routing", async () => {
  let calls = 0;
  const denied = makeGatewayTaskSurface({
    authenticate: async () => false,
    client: {
      callTaskTool: async () => {
        calls++;
        return {};
      },
    },
  });
  expect(
    (await denied(new Request("http://127.0.0.1/mcp", { method: "POST", body: "private" }))).status,
  ).toBe(401);
  expect(calls).toBe(0);
  const surface = makeGatewayTaskSurface({
    authenticate: async () => true,
    client: {
      callTaskTool: async () => {
        calls++;
        return {};
      },
    },
  });
  const list = await surface(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const body = await list.text();
  expect(body).toContain("t3_lan_task_launch");
  expect(body).not.toContain("switchyard_run_start");
  const native = await surface(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "t3_project_delete", arguments: {} },
      }),
    }),
  );
  expect(await native.text()).toContain("task_tool_required");
  expect(calls).toBe(0);
});

it("leaves observations unacknowledged if the durable receiver fails", async () => {
  const environmentId = EnvironmentId.make("environment:approved");
  const threadId = ThreadId.make("thread:native");
  const eventId = EventId.make("event:terminal");
  const fact = {
    eventId,
    sequence: 2,
    kind: "run_terminal",
    runId: RunId.make("run:native"),
    requestId: null,
    status: "completed",
  };
  const calls: Array<string> = [];
  const client = {
    callTaskTool: async (name: string) => {
      calls.push(name);
      return {
        environmentId,
        result: {
          sourceId: EventId.make("event:source"),
          threadId,
          taskWorkState: "result_available",
          taskResultRunId: RunId.make("run:native"),
          taskResultStatus: "completed",
          hasMore: false,
          nextCursor: { sourceId: EventId.make("event:source"), sequence: 2 },
          headSequence: 2,
          status: "ok",
          delivery: { events: [fact], hasMore: false },
        },
      };
    },
  };
  await expect(
    observeGatewayTask({
      client,
      environmentId,
      threadId,
      accept: async () => {
        throw new Error("Mock store unavailable");
      },
    }),
  ).rejects.toThrow("Mock store unavailable");
  expect(calls).toEqual(["t3_lan_task_observe"]);
  const accepted = new Set<string>();
  const accept = async ({ key }: { readonly key: string }) => {
    accepted.add(key);
  };
  expect(await observeGatewayTask({ client, environmentId, threadId, accept })).toMatchObject({
    status: "accepted",
    wakeDelivery: "unsupported",
  });
  await observeGatewayTask({ client, environmentId, threadId, accept });
  expect(accepted.size).toBe(1);
  expect(calls.filter((name) => name === "t3_lan_events_ack")).toHaveLength(2);
});

it("keeps replay continuation visible when a settled task has an empty filtered source page", async () => {
  const environmentId = EnvironmentId.make("environment:approved");
  const threadId = ThreadId.make("thread:native");
  const sourceId = EventId.make("event:source");
  const runId = RunId.make("run:native");
  const facts: Array<string> = [];
  let observed = 0;
  const client = {
    callTaskTool: async (name: string) => {
      if (name === "t3_lan_events_ack") return {};
      observed++;
      const hasMore = observed === 1;
      return {
        environmentId,
        result: {
          threadId,
          sourceId,
          status: "ok",
          taskWorkState: "result_available",
          taskResultRunId: runId,
          taskResultStatus: "completed",
          hasMore,
          headSequence: 101,
          nextCursor: { sourceId, sequence: hasMore ? 100 : 101 },
          delivery: {
            hasMore: false,
            events: hasMore
              ? []
              : [
                  {
                    eventId: EventId.make("event:terminal"),
                    sequence: 101,
                    kind: "run_terminal",
                    runId,
                    requestId: null,
                    status: "completed",
                  },
                ],
          },
        },
      };
    },
  };
  const accept = async ({ key }: { readonly key: string }) => {
    facts.push(key);
  };
  const first = await observeGatewayTask({ client, environmentId, threadId, accept });
  expect(first).toMatchObject({
    hasMore: true,
    replayDrained: false,
    taskWorkState: "result_available",
    count: 0,
  });
  const second = await observeGatewayTask({ client, environmentId, threadId, accept });
  expect(second).toMatchObject({ hasMore: false, replayDrained: true, count: 1 });
  expect(facts).toHaveLength(1);
});
