import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  AgentFactRelayCursor,
  AgentFactRelayDecision,
  AgentFactRelayRead,
  AgentFactRelayValidate,
} from "../../../../packages/contracts/src/agentEventRelay.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { PeerCallLimits } from "../peer/PeerMcpClient.ts";
import type { FactData } from "./AgentFactStore.ts";

export interface RelayAuthorization {
  /** Trusted immediate peer, resolved from the authenticated session/link, never a tool argument. */
  readonly peerEnvironmentId: string;
  /** Changes on session, token, link, Labs, read/outside-sharing cap or mode-ceiling changes; per-request narrowed limits are carried separately. */
  readonly generation: string;
  readonly limits: PeerCallLimits;
}
export type RelayAccess =
  | { readonly verdict: "allowed"; readonly authorization: RelayAuthorization }
  | Exclude<AgentFactRelayDecision, { readonly verdict: "allowed" }>;

/**
 * Required, fail-closed port. Share with session/link/cap/Labs/deletion removal gates; no network waits.
 * Bind incoming sessions to trusted immediate peers: linked/software_id/client_name are insufficient.
 * PeerLinks.resolve performs network I/O and cannot implement this gate.
 */
export class AgentFactRelayAccess extends Context.Service<
  AgentFactRelayAccess,
  {
    readonly withGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly incoming: (scope: McpInvocationScope) => Effect.Effect<RelayAccess>;
    readonly outgoing: (environmentId: string) => Effect.Effect<RelayAccess>;
    /** Also checks current requester session/read/outside-sharing rights and mode limits. */
    readonly requester: (input: {
      readonly sessionId: string;
      readonly attributionSubject: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayAccess>;
    /** Per-fact origin visibility. Caller must hold the shared gate/transaction after a fresh incoming proof for this page; never reuse that proof across calls. Owner data never participates. */
    readonly originFact: (input: {
      readonly scope: McpInvocationScope;
      readonly authorization: RelayAuthorization;
      readonly eventId: string;
      readonly data: FactData;
    }) => Effect.Effect<AgentFactRelayDecision>;
  }
>()("t3/agentEvents/AgentFactRelayAccess") {}

export class RelayPeerError extends Schema.TaggedError<RelayPeerError>()(
  "AgentFactRelayPeerError",
  {
    reason: Schema.Literals(["unreachable", "unsupported", "refused", "invalid_response"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The linked fact source could not be read or validated.";
  }
}

/**
 * Parent supplies authenticated PeerMcpClient calls (writes:false, the captured narrowed limits).
 * Read => t3_link_agent_facts; validate => t3_link_agent_fact_authority. Use success: Schema.Unknown:
 * preserve raw JSON for strict domain decoding. Only verified missing-tool evidence means unsupported.
 * No transport response is an access grant: the service rechecks the captured generation at admission.
 */
export class AgentFactRelayTransport extends Context.Service<
  AgentFactRelayTransport,
  {
    readonly read: (input: {
      readonly authorization: RelayAuthorization;
      readonly request: AgentFactRelayRead;
    }) => Effect.Effect<unknown, RelayPeerError>;
    readonly validate: (input: {
      readonly authorization: RelayAuthorization;
      readonly request: AgentFactRelayValidate;
    }) => Effect.Effect<unknown, RelayPeerError>;
  }
>()("t3/agentEvents/AgentFactRelayAccess/AgentFactRelayTransport") {}

/** Register then compare the log cursor to avoid a missed wake; enforce waitMs as a ceiling.
 * Called outside SQL and authority gates. Parent wires this to its shared fact/probe commit feed.
 */
export class AgentFactRelayWake extends Context.Service<
  AgentFactRelayWake,
  {
    readonly wait: (after: AgentFactRelayCursor, waitMs: number) => Effect.Effect<void>;
  }
>()("t3/agentEvents/AgentFactRelayAccess/AgentFactRelayWake") {}
