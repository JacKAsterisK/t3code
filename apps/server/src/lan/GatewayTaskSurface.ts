import {
  LanTaskObservation,
  LanTaskObserveResult,
  LanToolParameters,
  EnvironmentId,
  EventId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import type { makeGatewayT3OAuthClient } from "./GatewayT3OAuthClient.ts";

type Client = Pick<ReturnType<typeof makeGatewayT3OAuthClient>, "callTaskTool">;
const ToolCall = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const RpcInput = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const ObservationDelivery = Schema.Struct({
  environmentId: EnvironmentId,
  result: Schema.Struct({
    sourceId: EventId,
    threadId: ThreadId,
    status: Schema.Literals(["ok", "reset_required"]),
    taskWorkState: LanTaskObserveResult.fields.taskWorkState,
    taskResultRunId: LanTaskObserveResult.fields.taskResultRunId,
    taskResultStatus: LanTaskObserveResult.fields.taskResultStatus,
    hasMore: LanTaskObserveResult.fields.hasMore,
    nextCursor: LanTaskObserveResult.fields.nextCursor,
    headSequence: LanTaskObserveResult.fields.headSequence,
    delivery: Schema.Struct({
      events: Schema.Array(LanTaskObservation).check(Schema.isMaxLength(100)),
      hasMore: Schema.Boolean,
    }),
  }),
});
const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(RpcInput));
const decodeToolCall = Schema.decodeUnknownSync(ToolCall);
const decodeDelivery = Schema.decodeUnknownSync(ObservationDelivery);
const catalog = Object.entries(LanToolParameters).map(([name, parameters]) => ({
  name,
  description:
    "Native T3 task routing. Use explicit environment IDs and stable request IDs. Approval facts do not confer approval authority; run_terminal does not prove all task work has ended. Read/observe before claiming completion. ACK only after durable receipt. Wake delivery is unsupported.",
  inputSchema: Tool.getJsonSchema(Tool.make(name, { parameters, success: Schema.Unknown })),
}));
const argumentDecoders = new Map(
  Object.entries(LanToolParameters).map(([name, parameters]) => [
    name,
    Schema.decodeUnknownSync(Schema.toCodecJson(parameters), { onExcessProperty: "error" }),
  ]),
);

export const gatewayTaskCatalog = () => structuredClone(catalog);

export const validateGatewayTaskCall = (name: string, args: unknown): Record<string, unknown> => {
  const decode = argumentDecoders.get(name);
  if (decode === undefined) throw new Error("task_tool_required");
  return decode(args) as Record<string, unknown>;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Embedded behind the existing gateway's authentication; this module opens no listener. */
export const makeGatewayTaskSurface =
  (options: {
    readonly client: Client;
    readonly authenticate: (request: Request) => Promise<boolean>;
  }) =>
  async (request: Request): Promise<Response> => {
    if (!(await options.authenticate(request))) return json(401, { error: "unauthorized" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (request.headers.has("origin")) return json(403, { error: "origin_not_allowed" });
    let input: typeof RpcInput.Type;
    try {
      if (Number(request.headers.get("content-length") ?? 0) > 256_000)
        return json(413, { error: "frame_too_large" });
      const reader = request.body?.getReader();
      if (reader === undefined) return json(400, { error: "invalid_frame" });
      const chunks: Array<Uint8Array> = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 256_000) return json(413, { error: "frame_too_large" });
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      input = decodeInput(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return json(400, { error: "invalid_frame" });
    }
    const error = (code: number, message: string) =>
      json(200, { jsonrpc: "2.0", id: input.id ?? null, error: { code, message } });
    if (input.id === undefined)
      return input.method === "notifications/initialized"
        ? new Response(null, { status: 202 })
        : json(400, { error: "unsupported_notification" });
    if (input.method === "initialize")
      return json(200, {
        jsonrpc: "2.0",
        id: input.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "T3 task gateway", version: "1" },
        },
      });
    if (input.method === "ping") return json(200, { jsonrpc: "2.0", id: input.id, result: {} });
    if (input.method === "tools/list")
      return json(200, { jsonrpc: "2.0", id: input.id, result: { tools: gatewayTaskCatalog() } });
    if (input.method !== "tools/call") return error(-32601, "method_not_found");
    try {
      const params = decodeToolCall(input.params);
      if (!catalog.some((tool) => tool.name === params.name))
        return error(-32602, "task_tool_required");
      const args = validateGatewayTaskCall(params.name, params.arguments ?? {});
      const result = await options.client.callTaskTool(params.name, args);
      return json(200, {
        jsonrpc: "2.0",
        id: input.id,
        result: {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      });
    } catch {
      return error(-32000, "task_operation_not_confirmed");
    }
  };

/** A scheduler may call this after reconnect. The receiver must durably deduplicate before ACK. */
export const observeGatewayTask = async (options: {
  readonly client: Client;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly accept: (event: {
    readonly key: string;
    readonly fact: typeof LanTaskObservation.Type;
  }) => Promise<void>;
  readonly acceptState?: (state: {
    readonly taskWorkState: LanTaskObserveResult["taskWorkState"];
    readonly taskResultRunId: LanTaskObserveResult["taskResultRunId"];
    readonly taskResultStatus: LanTaskObserveResult["taskResultStatus"];
  }) => Promise<void>;
}) => {
  const raw = await options.client.callTaskTool("t3_lan_task_observe", {
    environmentId: options.environmentId,
    threadId: options.threadId,
  });
  const page = decodeDelivery(raw);
  if (page.environmentId !== options.environmentId || page.result.threadId !== options.threadId)
    throw new Error("Task observation identity mismatch.");
  if (page.result.status === "reset_required")
    return { status: "reset_required", wakeDelivery: "unsupported" } as const;
  for (const fact of page.result.delivery.events) {
    await options.accept({
      key: JSON.stringify([
        page.environmentId,
        options.threadId,
        page.result.sourceId,
        fact.eventId,
      ]),
      fact,
    });
  }
  const task = {
    taskWorkState: page.result.taskWorkState,
    taskResultRunId: page.result.taskResultRunId,
    taskResultStatus: page.result.taskResultStatus,
  };
  await options.acceptState?.(task);
  await options.client.callTaskTool("t3_lan_events_ack", {
    environmentId: options.environmentId,
    threadId: options.threadId,
    sourceId: page.result.sourceId,
    eventIds: page.result.delivery.events.map((fact) => fact.eventId),
  });
  return {
    status: "accepted",
    wakeDelivery: "unsupported",
    count: page.result.delivery.events.length,
    hasMore: page.result.hasMore || page.result.delivery.hasMore,
    replayDrained: !page.result.hasMore && !page.result.delivery.hasMore,
    nextCursor: page.result.nextCursor,
    headSequence: page.result.headSequence,
    ...task,
  } as const;
};
