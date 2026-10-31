import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createApprovalAdministrationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const inspect = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:approvals:administration",
    tag: WS_METHODS.approvalAdministrationInspect,
    staleTimeMs: 0,
    refreshIntervalMs: 10_000,
  });
  const mutate = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:approvals:administration",
    tag: WS_METHODS.approvalAdministrationMutate,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    onSettled: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(inspect({ environmentId, input: {} }))),
  });
  return { inspect, mutate };
}
