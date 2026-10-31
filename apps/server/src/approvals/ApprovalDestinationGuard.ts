import {
  RuntimeMode,
  ProviderInteractionMode,
  type ApprovalGuard,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ApprovalAuthority from "../auth/ApprovalAuthority.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Delegations from "./ApprovalDelegations.ts";

export class ApprovalDestinationGuard extends Context.Service<
  ApprovalDestinationGuard,
  {
    readonly check: (
      guard: ApprovalGuard,
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly revision: number; readonly runtimeModeCeiling: string },
      ApprovalAuthority.ApprovalAuthorityError
    >;
  }
>()("t3/approvals/ApprovalDestinationGuard") {}

const isDelegationError = Schema.is(Delegations.ApprovalDelegationError);
const isAuthorityError = Schema.is(ApprovalAuthority.ApprovalAuthorityError);
const decodeRuntimeMode = Schema.decodeUnknownEffect(RuntimeMode);
const decodeInteractionMode = Schema.decodeUnknownEffect(ProviderInteractionMode);
const make = Effect.gen(function* () {
  const delegations = yield* Delegations.ApprovalDelegations;
  const access = yield* Delegations.ApprovalDestinationAccess;
  const settings = yield* ServerSettings.ServerSettingsService;
  const check = Effect.fn("ApprovalDestinationGuard.check")(
    function* (guard: ApprovalGuard, threadId: ThreadId) {
      const destination = guard.destination;
      if (
        destination === undefined ||
        destination.authority.threadId !== threadId ||
        !(yield* settings.getSettings).linkedEnvironmentsEnabled
      )
        return yield* new ApprovalAuthority.ApprovalAuthorityError({ reason: "authority_revoked" });
      const original =
        access.currentBinding === undefined ? yield* access.peer(guard.sessionId) : undefined;
      const binding =
        access.currentBinding === undefined
          ? {
              sessionId: guard.sessionId,
              preparedRevision: original?.credentialRevision,
              peer: original,
            }
          : yield* access.currentBinding(
              destination.authority.linkIdentityId,
              guard.sessionId,
              destination.authority.credentialRevision,
            );
      const peer = binding?.peer;
      if (
        binding === undefined ||
        peer === undefined ||
        binding.preparedRevision !== destination.authority.credentialRevision
      )
        return yield* new ApprovalAuthority.ApprovalAuthorityError({ reason: "authority_revoked" });
      // Only a persisted, server-built guard reaches this path; the session is reauthenticated live.
      const handle = yield* delegations.authenticate(destination.authority.initiatingClientId).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: guard.environmentId,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          requestNamespace: destination.forwardingKey,
          thread: undefined,
          client: {
            sessionId: binding.sessionId,
            label: guard.actor.label,
            linked: true,
            access: peer.access,
            narrowedTo: {
              runtimeMode: yield* decodeRuntimeMode(guard.runtimeModeCeiling),
              interactionMode: yield* decodeInteractionMode(guard.interactionModeCeiling),
            },
          },
          linkedEnvironments: true,
        }),
      );
      const current = yield* delegations.check(handle, threadId, {
        ...destination.authority,
        credentialRevision: peer.credentialRevision,
      });
      return { revision: current.credentialRevision, runtimeModeCeiling: peer.runtimeModeCeiling };
    },
    (effect) =>
      access.withGate(effect).pipe(
        Effect.mapError((cause) =>
          isAuthorityError(cause)
            ? cause
            : new ApprovalAuthority.ApprovalAuthorityError({
                reason:
                  !isDelegationError(cause) || cause.reason === "storage_unavailable"
                    ? "storage_unavailable"
                    : cause.reason === "mode_ceiling"
                      ? "mode_changed"
                      : "authority_revoked",
                cause,
              }),
        ),
      ),
  );
  return ApprovalDestinationGuard.of({ check });
});

export const layer = Layer.effect(ApprovalDestinationGuard, make);
