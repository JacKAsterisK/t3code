import {
  type EnvironmentId,
  type OrchestrationV2RuntimeModeChange,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type { DispatchModes } from "./DispatchModeLimit.ts";

type ClientActor = Extract<
  OrchestrationV2RuntimeModeChange["actor"],
  { readonly sessionId: string }
>;

export const ThreadRuntimeModeChange = Context.Reference<
  | {
      readonly expectedRuntimeMode: RuntimeMode;
      readonly caller:
        | {
            readonly kind: "thread";
            readonly environmentId: EnvironmentId;
            readonly threadId: ThreadId;
            readonly providerInstanceId: ProviderInstanceId;
          }
        | {
            readonly kind: "client";
            readonly actor: ClientActor;
            readonly limits: DispatchModes;
            readonly fenced: boolean;
          };
    }
  | undefined
>("t3/orchestration-v2/ThreadRuntimeModeChange", { defaultValue: () => undefined });

export class ThreadRuntimeModeChangeError extends Schema.TaggedError<ThreadRuntimeModeChangeError>()(
  "ThreadRuntimeModeChangeError",
  {
    code: Schema.Literals([
      "capability_denied",
      "mode_changed",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "thread_busy",
      "unsupported_runtime_mode",
    ]),
    message: Schema.String,
  },
) {}
