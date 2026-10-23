import * as Effect from "effect/Effect";
import * as EnvironmentRouting from "../../../lan/EnvironmentRouting.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LanToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(
  LanToolkit,
  Effect.gen(function* () {
    const service = yield* EnvironmentRouting.EnvironmentRouting;
    return {
      t3_lan_environments: McpToolAccess.reads(() =>
        McpInvocationContext.McpInvocationContext.pipe(Effect.flatMap(service.environments)),
      ),
      t3_lan_task_launch: McpToolAccess.writes((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.launch(scope, input)),
        ),
      ),
      t3_lan_task_list: McpToolAccess.reads((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.list(scope, input)),
        ),
      ),
      t3_lan_task_read: McpToolAccess.reads((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.read(scope, input)),
        ),
      ),
      t3_lan_task_send: McpToolAccess.writes((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.send(scope, input)),
        ),
      ),
      t3_lan_task_interrupt: McpToolAccess.writes((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.interrupt(scope, input)),
        ),
      ),
      t3_lan_task_requests: McpToolAccess.reads((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.requests(scope, input)),
        ),
      ),
      t3_lan_task_respond: McpToolAccess.writes((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.respond(scope, input)),
        ),
      ),
      t3_lan_task_observe: McpToolAccess.reads((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.observe(scope, input)),
        ),
      ),
      t3_lan_events_ack: McpToolAccess.reads((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => service.acknowledge(scope, input)),
        ),
      ),
    };
  }),
);
