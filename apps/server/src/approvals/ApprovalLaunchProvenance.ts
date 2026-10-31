import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Authority from "../auth/ApprovalAuthority.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Delegations from "./ApprovalDelegations.ts";

export const INITIATING_CLIENT_HEADER = "t3-initiating-client-id";
const validClientId = (value: string | undefined): value is string =>
  value !== undefined &&
  value.length > 0 &&
  value.length <= 512 &&
  /^[A-Za-z0-9:._-]+$/u.test(value);

export const withIncomingLaunchProvenance = (
  scope: Invocation.McpInvocationScope,
  headers: Readonly<Record<string, string | undefined>>,
): Invocation.McpInvocationScope => {
  const asserted = headers[INITIATING_CLIENT_HEADER];
  return scope.client?.linked === true && validClientId(asserted)
    ? { ...scope, client: { ...scope.client, assertedInitiatingClientId: asserted } }
    : scope;
};

export const initiatingClientForForward = Effect.fn(
  "ApprovalLaunchProvenance.initiatingClientForForward",
)(function* (
  scope: Invocation.McpInvocationScope,
  authority: Authority.ApprovalAuthority["Service"] | undefined,
) {
  if (
    authority === undefined ||
    scope.thread !== undefined ||
    scope.client === undefined ||
    scope.client.linked === true ||
    scope.client.taskOnly === true ||
    scope.client.grantId !== undefined
  )
    return undefined;
  const current = yield* authority.identity(scope.client.sessionId).pipe(
    Effect.asSome,
    Effect.catchTags({
      ApprovalAuthorityError: (error) =>
        error.reason === "storage_unavailable" ? Effect.fail(error) : Effect.succeedNone,
    }),
  );
  return Option.isSome(current) ? current.value.initiating_client_id : undefined;
});

interface CreationProvenance {
  readonly withAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly record: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<void, Delegations.ApprovalDelegationError>;
}

export const ApprovalCreationProvenance = Context.Reference<CreationProvenance | undefined>(
  "t3/approvals/ApprovalCreationProvenance",
  { defaultValue: () => undefined },
);

export const makeCapture = Effect.gen(function* () {
  const delegations = yield* Effect.serviceOption(Delegations.ApprovalDelegations);
  const access = yield* Effect.serviceOption(Delegations.ApprovalDestinationAccess);
  return Effect.fn("ApprovalLaunchProvenance.capture")(function* () {
    const invocation = yield* Effect.serviceOption(Invocation.McpInvocationContext);
    if (Option.isNone(delegations) || Option.isNone(access) || Option.isNone(invocation))
      return undefined;
    const scope = invocation.value;
    const asserted = scope.client?.assertedInitiatingClientId;
    if (scope.client?.linked !== true || !validClientId(asserted)) return undefined;
    const handle = yield* delegations.value.authenticate(asserted).pipe(
      Effect.provideService(Invocation.McpInvocationContext, scope),
      Effect.asSome,
      Effect.catchTags({
        ApprovalDelegationError: (error) =>
          error.reason === "storage_unavailable" ? Effect.fail(error) : Effect.succeedNone,
      }),
    );
    if (Option.isNone(handle)) return undefined;
    return {
      withAdmission: access.value.withGate,
      record: Effect.fn("ApprovalLaunchProvenance.record")(function* (
        stored: OrchestrationV2StoredEvent,
      ) {
        if (stored.event.type !== "thread.created") return;
        if (stored.commandId === null)
          return yield* new Delegations.ApprovalDelegationError({ reason: "invalid_provenance" });
        yield* delegations.value.recordOrigin(handle.value, {
          threadId: stored.event.threadId,
          creationCommandId: stored.commandId,
          createdSequence: stored.sequence,
        });
      }),
    } satisfies CreationProvenance;
  });
});
