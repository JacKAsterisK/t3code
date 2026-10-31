import * as Schema from "effect/Schema";

/** Internal native-link protocol. No caller-supplied environment or client identity is accepted. */
export const AGENT_FACT_RELAY_LIMITS = {
  pageSize: 100,
  pageBytes: 262_144,
  waitMs: 45_000,
  factBytes: 16_384,
} as const;
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const CheckedAt = Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(40));
const Sequence = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const AgentFactRelayCursor = Schema.Struct({ epoch: Identifier, seq: Sequence });
export type AgentFactRelayCursor = typeof AgentFactRelayCursor.Type;
export const AgentFactRelayRead = Schema.Struct({
  /** Null starts at the current head without replay. A saved cursor resumes; lost history replays the floor. */
  after: Schema.NullOr(AgentFactRelayCursor),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_FACT_RELAY_LIMITS.pageSize })),
  ),
  waitMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: AGENT_FACT_RELAY_LIMITS.waitMs })),
  ),
});
export type AgentFactRelayRead = typeof AgentFactRelayRead.Type;
export const AgentFactRelayEntry = Schema.Struct({
  seq: Sequence,
  eventId: Identifier,
  /** Canonical origin bytes, before this receiver adds its first durable relay metadata. */
  dataJson: Schema.String.check(Schema.isMaxLength(AGENT_FACT_RELAY_LIMITS.factBytes)),
});
export type AgentFactRelayEntry = typeof AgentFactRelayEntry.Type;
export const AgentFactRelayPage = Schema.Struct({
  epoch: Identifier,
  facts: Schema.Array(AgentFactRelayEntry).check(
    Schema.isMaxLength(AGENT_FACT_RELAY_LIMITS.pageSize),
  ),
  next: AgentFactRelayCursor,
  floorSeq: Sequence,
  headSeq: Sequence,
  truncated: Schema.Boolean,
  authorizationGeneration: Identifier,
  checkedAt: CheckedAt,
});
export type AgentFactRelayPage = typeof AgentFactRelayPage.Type;
export const AgentFactRelayReference = Schema.Struct({
  eventId: Identifier,
  originGeneration: Identifier,
  threadId: Schema.NullOr(Identifier),
});
export type AgentFactRelayReference = typeof AgentFactRelayReference.Type;
export const AgentFactRelayValidate = Schema.Struct({
  references: Schema.Array(AgentFactRelayReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_FACT_RELAY_LIMITS.pageSize),
  ),
  authorizationGeneration: Schema.NullOr(Identifier),
});
export type AgentFactRelayValidate = typeof AgentFactRelayValidate.Type;
export const AgentFactRelayRefusal = Schema.Literals([
  "session_inactive",
  "links_disabled",
  "credential_changed",
  "read_scope_lost",
  "outside_sharing_refused",
  "thread_unreadable",
  "source_changed",
]);
export type AgentFactRelayRefusal = typeof AgentFactRelayRefusal.Type;
export const AgentFactRelayDecision = Schema.Union([
  Schema.Struct({ verdict: Schema.Literal("allowed") }),
  Schema.Struct({ verdict: Schema.Literal("refused"), reason: AgentFactRelayRefusal }),
  Schema.Struct({ verdict: Schema.Literal("unavailable") }),
]);
export type AgentFactRelayDecision = typeof AgentFactRelayDecision.Type;
export const AgentFactRelayProof = Schema.Struct({
  authorizationGeneration: Identifier,
  checkedAt: CheckedAt,
  results: Schema.Array(
    Schema.Struct({
      reference: AgentFactRelayReference,
      decision: AgentFactRelayDecision,
    }),
  ).check(Schema.isMaxLength(AGENT_FACT_RELAY_LIMITS.pageSize)),
});
export type AgentFactRelayProof = typeof AgentFactRelayProof.Type;
