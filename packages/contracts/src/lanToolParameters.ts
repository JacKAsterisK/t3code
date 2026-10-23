import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, RunId } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { LanEventsAckInput } from "./lanRouting.ts";
import {
  LanTaskClientRequestId,
  LanTaskLaunchInput,
  LanTaskObserveInput,
  LanTaskRequestsInput,
  LanTaskRespondInput,
} from "./lanTasks.ts";
import {
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
} from "./orchestratorMcp.ts";

const target = { environmentId: EnvironmentId, runtimeCeiling: Schema.optionalKey(RuntimeMode) };

export const LanToolParameters = {
  t3_lan_environments: Schema.Struct({}),
  t3_lan_task_launch: Schema.Struct({ ...LanTaskLaunchInput.fields, ...target }),
  t3_lan_task_list: Schema.Struct({
    ...OrchestratorMcpThreadListInput.fields,
    projectId: ProjectId,
    ...target,
  }),
  t3_lan_task_read: Schema.Struct({ ...OrchestratorMcpThreadReadInput.fields, ...target }),
  t3_lan_task_send: Schema.Struct({
    ...OrchestratorMcpThreadSendInput.fields,
    mode: Schema.optionalKey(Schema.Literals(["auto", "queue"])),
    clientRequestId: LanTaskClientRequestId,
    ...target,
  }),
  t3_lan_task_interrupt: Schema.Struct({
    ...OrchestratorMcpThreadInterruptInput.fields,
    runId: RunId,
    clientRequestId: LanTaskClientRequestId,
    ...target,
  }),
  t3_lan_task_requests: Schema.Struct({ ...LanTaskRequestsInput.fields, ...target }),
  t3_lan_task_respond: Schema.Struct({ ...LanTaskRespondInput.fields, ...target }),
  t3_lan_task_observe: Schema.Struct({
    ...LanTaskObserveInput.fields,
    replayFromStart: Schema.optionalKey(Schema.Boolean),
    ...target,
  }),
  t3_lan_events_ack: Schema.Struct({ ...LanEventsAckInput.fields, ...target }),
};
