import type { AgentEventDirectoryReference } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** Server-only context; no native command or transport accepts an asserted capture reference. */
export const AgentEventCapture = Context.Reference<AgentEventDirectoryReference | undefined>(
  "t3/persistence/AgentEventCapture",
  { defaultValue: () => undefined },
);
