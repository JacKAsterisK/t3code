// @effect-diagnostics nodeBuiltinImport:off -- Durable import tombstones hash canonical original bytes.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Wire from "../../../../packages/contracts/src/agentEventRelay.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Access from "./AgentFactRelayAccess.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as Store from "./AgentEventStore.ts";
import * as Facts from "./AgentFactStore.ts";
import * as Internal from "./AgentInternalFacts.ts";

export class RelayError extends Schema.TaggedError<RelayError>()("AgentFactRelayError", {
  reason: Schema.Literals([
    "invalid_request",
    "capability_denied",
    "authority_unavailable",
    "stale_cursor",
    "invalid_page",
    "identity_changed",
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return "The fact relay could not safely advance or establish current authority.";
  }
}
const isRelayError = Schema.is(RelayError);
const decodeRead = Schema.decodeEffect(Wire.AgentFactRelayRead);
const decodeValidate = Schema.decodeEffect(Wire.AgentFactRelayValidate);
const decodePage = Schema.decodeUnknownEffect(Wire.AgentFactRelayPage);
const decodeProof = Schema.decodeUnknownEffect(Wire.AgentFactRelayProof);
export interface PeerCursor {
  readonly environmentId: string;
  readonly peerEpoch: string;
  readonly peerSeq: number;
  readonly status: "following" | "unreachable" | "unsupported" | "gap";
  readonly statusTransition: number;
  readonly authorizationGeneration: string | null;
  readonly updatedAt: number;
  readonly detail: string | null;
}
export interface CachedFactProof {
  readonly decision: Wire.AgentFactRelayDecision;
  readonly checkedAt: string | null;
  readonly originAuthorizationGeneration: string | null;
  readonly authorizationGeneration: string | null;
}
export class AgentFactRelay extends Context.Service<
  AgentFactRelay,
  {
    /** Peer-only origin read; invocation context is supplied by authenticated MCP middleware. */
    readonly readOrigin: (
      input: Wire.AgentFactRelayRead,
    ) => Effect.Effect<
      Wire.AgentFactRelayPage,
      RelayError,
      McpInvocationContext.McpInvocationContext
    >;
    readonly validateOrigin: (
      input: Wire.AgentFactRelayValidate,
    ) => Effect.Effect<
      Wire.AgentFactRelayProof,
      RelayError,
      McpInvocationContext.McpInvocationContext
    >;
    /** One bounded pull. The parent owns discovery, following fibers and retry scheduling. */
    readonly followOnce: (
      environmentId: string,
      waitMs?: number,
    ) => Effect.Effect<
      {
        readonly imported: number;
        readonly cursor: PeerCursor;
      },
      RelayError
    >;
    readonly peerCursor: (
      environmentId: string,
    ) => Effect.Effect<PeerCursor | undefined, RelayError>;
    /** A fresh per-fact proof, never a grant derived from a previous successful poll. */
    readonly checkCached: (input: {
      readonly sessionId: string;
      readonly attributionSubject: string;
      readonly eventId: string;
    }) => Effect.Effect<CachedFactProof>;
  }
>()("t3/agentEvents/AgentFactRelay") {}

const storageError = (cause: unknown) =>
  isRelayError(cause) ? cause : new RelayError({ reason: "storage", cause });
const same = (left: unknown, right: unknown) => stableStringify(left) === stableStringify(right);
const narrowLimits = (
  link: Access.RelayAuthorization["limits"],
  requester: Access.RelayAuthorization["limits"],
): Access.RelayAuthorization["limits"] => {
  const rank = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };
  return {
    runtimeMode:
      rank[link.runtimeMode] < rank[requester.runtimeMode]
        ? link.runtimeMode
        : requester.runtimeMode,
    interactionMode:
      link.interactionMode === "plan" || requester.interactionMode === "plan" ? "plan" : "default",
  };
};
const iso = (now: number) => DateTime.formatIso(DateTime.makeUnsafe(now));
const unavailableProof: CachedFactProof = {
  decision: { verdict: "unavailable" },
  checkedAt: null,
  originAuthorizationGeneration: null,
  authorizationGeneration: null,
};

const make = Effect.fn("AgentFactRelay.make")(function* (environment: {
  readonly id: string;
  readonly label: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* Access.AgentFactRelayAccess;
  const transport = yield* Access.AgentFactRelayTransport;
  const wake = yield* Access.AgentFactRelayWake;

  const peerCursor = Effect.fn("AgentFactRelay.peerCursor")(function* (environmentId: string) {
    return (yield* sql<PeerCursor>`SELECT environment_id AS "environmentId", peer_epoch AS "peerEpoch",
      peer_seq AS "peerSeq", status, status_transition AS "statusTransition",
      authorization_generation AS "authorizationGeneration", updated_at AS "updatedAt", detail
      FROM agent_event_peer_cursors WHERE environment_id = ${environmentId}`)[0];
  });
  const requireAccess = Effect.fn("AgentFactRelay.requireAccess")(function* (
    verdict: Access.RelayAccess,
  ) {
    if (verdict.verdict !== "allowed")
      return yield* new RelayError({
        reason: verdict.verdict === "unavailable" ? "authority_unavailable" : "capability_denied",
      });
    if (
      verdict.authorization.generation.length === 0 ||
      verdict.authorization.peerEnvironmentId.length === 0
    )
      return yield* new RelayError({ reason: "authority_unavailable" });
    return verdict.authorization;
  });
  const incoming = Effect.fn("AgentFactRelay.incoming")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    if (
      scope.environmentId !== environment.id ||
      scope.client?.linked !== true ||
      scope.thread !== undefined ||
      scope.client.taskOnly === true ||
      scope.linkedEnvironments !== true ||
      !scope.capabilities.has("orchestration")
    )
      return yield* new RelayError({ reason: "capability_denied" });
    return yield* requireAccess(yield* access.incoming(scope));
  });
  const canonical = Effect.fn("AgentFactRelay.canonical")(function* (json: string) {
    if (Buffer.byteLength(json, "utf8") > Wire.AGENT_FACT_RELAY_LIMITS.factBytes)
      return yield* new RelayError({ reason: "invalid_page" });
    const data = yield* Facts.decodeFactDataJson(json, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => new RelayError({ reason: "invalid_page", cause })),
    );
    if (stableStringify(data) !== json) return yield* new RelayError({ reason: "invalid_page" });
    return data;
  });
  const findFact = Effect.fn("AgentFactRelay.findFact")(function* (eventId: string) {
    return (yield* sql<{
      readonly dataJson: string;
      readonly relayedFrom: string | null;
    }>`SELECT data_json AS "dataJson", relayed_from AS "relayedFrom" FROM agent_event_facts WHERE event_id = ${eventId} AND source_kind <> 'gateway'`)[0];
  });
  const exportable = (data: Facts.FactData) =>
    data.origin.environmentId === environment.id &&
    data.relay === null &&
    (data.kind !== "source_status" || data.detail.environmentId === environment.id);
  const originDecision = Effect.fn("AgentFactRelay.originDecision")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    authorization: Access.RelayAuthorization,
    eventId: string,
    data: Facts.FactData,
  ) {
    const generation = (yield* sql<{
      readonly generation: string;
    }>`SELECT generation FROM agent_event_source_state WHERE id = 1`)[0]?.generation;
    if (generation === undefined) return { verdict: "unavailable" } as const;
    if (data.origin.sourceGeneration !== generation)
      return { verdict: "refused", reason: "source_changed" } as const;
    return yield* access.originFact({ scope, authorization, eventId, data });
  });

  const originPage = Effect.fn("AgentFactRelay.originPage")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    request: Wire.AgentFactRelayRead,
  ) {
    return yield* access.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          const authorization = yield* incoming(scope);
          const log = yield* Store.logState();
          const truncated =
            request.after === null
              ? false
              : request.after.epoch !== log.epoch ||
                request.after.seq < log.floorSeq - 1 ||
                request.after.seq > log.headSeq;
          const start =
            request.after === null ? log.headSeq : truncated ? log.floorSeq - 1 : request.after.seq;
          const rows = yield* sql<{
            readonly seq: number;
            readonly eventId: string;
            readonly dataJson: string | null;
            readonly relayedFrom: string | null;
          }>`SELECT log_seq AS seq, event_id AS "eventId", data_json AS "dataJson", relayed_from AS "relayedFrom" FROM (
        SELECT log_seq, event_id, ${Internal.catalogPayload(sql)} AS data_json, relayed_from FROM agent_event_facts
        UNION ALL SELECT log_seq, event_id, NULL AS data_json, NULL AS relayed_from FROM agent_event_probes
      ) WHERE log_seq > ${start} AND log_seq <= ${log.headSeq} ORDER BY log_seq LIMIT ${request.limit ?? 100}`;
          const facts: Array<Wire.AgentFactRelayEntry> = [];
          let seq = start;
          let bytes = 0;
          for (const row of rows) {
            if (row.seq !== seq + 1)
              return yield* new RelayError({ reason: "authority_unavailable" });
            // Private probes and imported facts are scanned, never exported. Their slots still advance next.
            if (row.dataJson !== null && row.relayedFrom === null) {
              const data = yield* canonical(row.dataJson);
              if (exportable(data)) {
                if (Facts.factEventId(data.origin, data.factKey) !== row.eventId)
                  return yield* new RelayError({ reason: "invalid_page" });
                const decision = yield* originDecision(scope, authorization, row.eventId, data);
                if (decision.verdict === "unavailable")
                  return yield* new RelayError({ reason: "authority_unavailable" });
                if (decision.verdict === "allowed") {
                  const entry = { seq: row.seq, eventId: row.eventId, dataJson: row.dataJson };
                  const size = Buffer.byteLength(stableStringify(entry), "utf8");
                  if (bytes + size > Wire.AGENT_FACT_RELAY_LIMITS.pageBytes - 4096) break;
                  facts.push(entry);
                  bytes += size;
                }
              }
            }
            seq = row.seq;
          }
          if (rows.length === 0 && start < log.headSeq)
            return yield* new RelayError({ reason: "authority_unavailable" });
          return {
            epoch: log.epoch,
            facts,
            next: { epoch: log.epoch, seq },
            floorSeq: log.floorSeq,
            headSeq: log.headSeq,
            truncated,
            authorizationGeneration: authorization.generation,
            checkedAt: iso(yield* Clock.currentTimeMillis),
          };
        }),
      ),
    );
  });
  const readOrigin = Effect.fn("AgentFactRelay.readOrigin")(function* (
    input: Wire.AgentFactRelayRead,
  ) {
    const request = yield* decodeRead(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => new RelayError({ reason: "invalid_request", cause })));
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const page = yield* originPage(scope, request);
    if ((request.waitMs ?? 0) === 0 || !same(request.after, page.next) || page.truncated)
      return page;
    // No SQL/admission/removal gate is held during a long poll. Recheck everything after waking.
    yield* wake.wait(page.next, request.waitMs!).pipe(Effect.timeoutOption(request.waitMs!));
    return yield* originPage(scope, request);
  });
  const validateOrigin = Effect.fn("AgentFactRelay.validateOrigin")(function* (
    input: Wire.AgentFactRelayValidate,
  ) {
    const request = yield* decodeValidate(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => new RelayError({ reason: "invalid_request", cause })));
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* access.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          const authorization = yield* incoming(scope);
          const results: Array<Wire.AgentFactRelayProof["results"][number]> = [];
          for (const reference of request.references) {
            const row = yield* findFact(reference.eventId);
            let decision: Wire.AgentFactRelayDecision = { verdict: "unavailable" };
            if (
              request.authorizationGeneration !== null &&
              request.authorizationGeneration !== authorization.generation
            ) {
              decision = { verdict: "unavailable" };
            } else if (row !== undefined) {
              const data = yield* canonical(row.dataJson);
              if (
                row.relayedFrom !== null ||
                !exportable(data) ||
                Facts.factEventId(data.origin, data.factKey) !== reference.eventId ||
                data.origin.sourceGeneration !== reference.originGeneration ||
                (typeof data.thread?.id === "string" ? data.thread.id : null) !== reference.threadId
              )
                decision = { verdict: "refused", reason: "source_changed" };
              else decision = yield* originDecision(scope, authorization, reference.eventId, data);
            }
            results.push({ reference, decision });
          }
          return {
            authorizationGeneration: authorization.generation,
            checkedAt: iso(yield* Clock.currentTimeMillis),
            results,
          };
        }),
      ),
    );
  });

  // These mutations are only called under the shared authority gate and enclosing SQL transaction.
  const saveCursor = Effect.fn("AgentFactRelay.saveCursor")(function* (cursor: PeerCursor) {
    yield* sql`INSERT INTO agent_event_peer_cursors
      (environment_id, peer_epoch, peer_seq, status, status_transition, authorization_generation, updated_at, detail)
      VALUES (${cursor.environmentId}, ${cursor.peerEpoch}, ${cursor.peerSeq}, ${cursor.status}, ${cursor.statusTransition},
        ${cursor.authorizationGeneration}, ${cursor.updatedAt}, ${cursor.detail})
      ON CONFLICT (environment_id) DO UPDATE SET peer_epoch = excluded.peer_epoch, peer_seq = excluded.peer_seq,
        status = excluded.status, status_transition = excluded.status_transition, authorization_generation = excluded.authorization_generation,
        updated_at = excluded.updated_at, detail = excluded.detail`;
  });
  const status = Effect.fn("AgentFactRelay.status")(function* (
    cursor: PeerCursor,
    next: PeerCursor["status"],
    detail: string | null,
    now: number,
  ) {
    if (cursor.status === next && cursor.statusTransition > 0)
      return { ...cursor, detail, updatedAt: now };
    const transition = cursor.statusTransition + 1;
    yield* Facts.appendFact({
      recordedAt: now,
      data: {
        schema: "t3.agent-event/1",
        kind: "source_status",
        factKey: `peer:${cursor.environmentId}:status`,
        summary: `Linked event source is ${next}.`,
        textIsUntrusted: true,
        environment,
        thread: null,
        run: null,
        owner: null,
        relay: null,
        origin: {
          environmentId: environment.id,
          sourceGeneration: yield* Journal.sourceGeneration(),
          sourceKind: "peer_status",
          sourceSequence: transition,
          transitionOrdinal: 0,
          threadSequence: null,
          occurredAt: iso(now),
        },
        detail: {
          environmentId: cursor.environmentId,
          status: next,
          transition,
          since: iso(now),
          detail,
        },
      },
    });
    return { ...cursor, status: next, statusTransition: transition, detail, updatedAt: now };
  });
  const initial = (environmentId: string, now: number): PeerCursor => ({
    environmentId,
    peerEpoch: "",
    peerSeq: 0,
    status: "unreachable",
    statusTransition: 0,
    authorizationGeneration: null,
    updatedAt: now,
    detail: null,
  });
  const expectCursor = Effect.fn("AgentFactRelay.expectCursor")(function* (
    environmentId: string,
    expected: PeerCursor | undefined,
  ) {
    if (!same(yield* peerCursor(environmentId), expected))
      return yield* new RelayError({ reason: "stale_cursor" });
  });
  const recordFailure = Effect.fn("AgentFactRelay.recordFailure")(function* (
    environmentId: string,
    expected: PeerCursor | undefined,
    next: "unreachable" | "unsupported",
    detail: string,
  ) {
    return yield* access.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* expectCursor(environmentId, expected);
          const now = yield* Clock.currentTimeMillis;
          const cursor = yield* status(
            { ...(expected ?? initial(environmentId, now)), authorizationGeneration: null },
            next,
            detail,
            now,
          );
          yield* saveCursor(cursor);
          return { imported: 0, cursor };
        }),
      ),
    );
  });
  const importEntry = Effect.fn("AgentFactRelay.importEntry")(function* (
    environmentId: string,
    entry: Wire.AgentFactRelayEntry,
    data: Facts.FactData,
    now: number,
  ) {
    const digest = NodeCrypto.createHash("sha256").update(entry.dataJson).digest("hex");
    // Kept beyond payload retention: a peer epoch reset must never allocate an old import twice.
    const receipt = (yield* sql<{
      readonly originEnvironmentId: string;
      readonly originalDigest: string;
      readonly relayedAt: number;
    }>`SELECT origin_environment_id AS "originEnvironmentId", original_digest AS "originalDigest", relayed_at AS "relayedAt"
      FROM agent_event_relay_imports WHERE event_id = ${entry.eventId}`)[0];
    if (
      receipt !== undefined &&
      (receipt.originEnvironmentId !== environmentId || receipt.originalDigest !== digest)
    )
      return yield* new RelayError({ reason: "identity_changed" });
    const existing = yield* findFact(entry.eventId);
    if (existing !== undefined) {
      const saved = yield* canonical(existing.dataJson);
      // Compare original canonical bytes, excluding the first receiver-owned relay metadata.
      if (
        existing.relayedFrom !== environmentId ||
        saved.relay?.viaEnvironmentId !== environment.id ||
        stableStringify({ ...saved, relay: null }) !== entry.dataJson ||
        (receipt !== undefined && saved.relay.relayedAt !== iso(receipt.relayedAt))
      )
        return yield* new RelayError({ reason: "identity_changed" });
      if (receipt === undefined) {
        const relayedAt = DateTime.makeUnsafe(saved.relay.relayedAt).epochMilliseconds;
        yield* sql`INSERT INTO agent_event_relay_imports (event_id, origin_environment_id, original_digest, relayed_at)
          VALUES (${entry.eventId}, ${environmentId}, ${digest}, ${relayedAt})`;
      }
      return false;
    }
    // A pruned payload remains handled. Its original digest and first relay time remain durable.
    if (receipt !== undefined) return false;
    if (
      (yield* sql`SELECT 1 FROM agent_event_occurrences WHERE event_id = ${entry.eventId}`).length >
      0
    )
      return yield* new RelayError({ reason: "identity_changed" });
    yield* Facts.appendFact({
      data: { ...data, relay: { viaEnvironmentId: environment.id, relayedAt: iso(now) } },
      recordedAt: now,
      relayedFrom: environmentId,
    });
    yield* sql`INSERT INTO agent_event_relay_imports (event_id, origin_environment_id, original_digest, relayed_at)
      VALUES (${entry.eventId}, ${environmentId}, ${digest}, ${now})`;
    return true;
  });
  const followOnce = Effect.fn("AgentFactRelay.followOnce")(function* (
    environmentId: string,
    waitMs: number = Wire.AGENT_FACT_RELAY_LIMITS.waitMs,
  ) {
    if (
      environmentId.length === 0 ||
      environmentId.length > 512 ||
      environmentId === environment.id ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > Wire.AGENT_FACT_RELAY_LIMITS.waitMs
    )
      return yield* new RelayError({ reason: "invalid_request" });
    const expected = yield* peerCursor(environmentId);
    const grant = yield* access.withGate(access.outgoing(environmentId));
    if (grant.verdict !== "allowed")
      return yield* recordFailure(
        environmentId,
        expected,
        "unreachable",
        grant.verdict === "unavailable" ? "authority_unavailable" : grant.reason,
      );
    const authorization = yield* requireAccess(grant);
    if (authorization.peerEnvironmentId !== environmentId)
      return yield* new RelayError({ reason: "capability_denied" });
    const after =
      expected === undefined || expected.peerEpoch === ""
        ? null
        : { epoch: expected.peerEpoch, seq: expected.peerSeq };
    return yield* Effect.gen(function* () {
      const response = yield* transport
        .read({
          authorization,
          request: { after, limit: 100, waitMs: after === null ? 0 : waitMs },
        })
        .pipe(Effect.result);
      if (response._tag === "Failure")
        return yield* recordFailure(
          environmentId,
          expected,
          response.failure.reason === "unsupported" ? "unsupported" : "unreachable",
          response.failure.reason,
        );
      const page = yield* decodePage(response.success, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((cause) => new RelayError({ reason: "invalid_page", cause })));
      const truncated =
        after === null
          ? false
          : after.epoch !== page.epoch || after.seq < page.floorSeq - 1 || after.seq > page.headSeq;
      const start = after === null ? page.headSeq : truncated ? page.floorSeq - 1 : after.seq;
      if (
        Buffer.byteLength(stableStringify(page), "utf8") > Wire.AGENT_FACT_RELAY_LIMITS.pageBytes ||
        page.next.epoch !== page.epoch ||
        page.floorSeq < 1 ||
        page.floorSeq > page.headSeq + 1 ||
        page.truncated !== truncated ||
        page.next.seq < start ||
        page.next.seq > page.headSeq ||
        page.next.seq - start > 100 ||
        (page.next.seq === start && start < page.headSeq)
      )
        return yield* new RelayError({ reason: "invalid_page" });
      let previous = start;
      const entries: Array<{
        readonly entry: Wire.AgentFactRelayEntry;
        readonly data: Facts.FactData;
      }> = [];
      const ids = new Set<string>();
      for (const entry of page.facts) {
        const data = yield* canonical(entry.dataJson);
        if (
          entry.seq <= previous ||
          entry.seq > page.next.seq ||
          ids.has(entry.eventId) ||
          data.relay !== null ||
          data.origin.environmentId !== environmentId ||
          data.environment.id !== environmentId ||
          (data.kind === "source_status" &&
            (data.thread !== null ||
              data.owner !== null ||
              data.run !== null ||
              data.detail.environmentId !== environmentId)) ||
          Facts.factEventId(data.origin, data.factKey) !== entry.eventId
        )
          return yield* new RelayError({ reason: "invalid_page" });
        previous = entry.seq;
        ids.add(entry.eventId);
        entries.push({ entry, data });
      }
      return yield* access.withGate(
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* requireAccess(yield* access.outgoing(environmentId));
            if (!same(current, authorization))
              return yield* new RelayError({ reason: "authority_unavailable" });
            yield* expectCursor(environmentId, expected);
            const now = yield* Clock.currentTimeMillis;
            let cursor = expected ?? initial(environmentId, now);
            if (page.truncated) cursor = yield* status(cursor, "gap", "peer_history_reset", now);
            let imported = 0;
            for (const { entry, data } of entries)
              if (yield* importEntry(environmentId, entry, data, now)) imported++;
            cursor = yield* status(
              {
                ...cursor,
                peerEpoch: page.epoch,
                peerSeq: page.next.seq,
                authorizationGeneration: page.authorizationGeneration,
              },
              "following",
              null,
              now,
            );
            yield* saveCursor(cursor);
            return { imported, cursor };
          }),
        ),
      );
    }).pipe(
      Effect.catchTags({
        AgentFactRelayError: (error) =>
          error.reason === "invalid_page" || error.reason === "identity_changed"
            ? recordFailure(environmentId, expected, "unsupported", error.reason)
            : Effect.fail(error),
      }),
    );
  });

  const checkCached = Effect.fn("AgentFactRelay.checkCached")(
    function* (input: {
      readonly sessionId: string;
      readonly attributionSubject: string;
      readonly eventId: string;
    }): Effect.fn.Return<CachedFactProof, unknown> {
      const prepared = yield* access.withGate(
        Effect.gen(function* () {
          const row = yield* findFact(input.eventId);
          if (row === undefined || row.relayedFrom === null) return undefined;
          const data = yield* canonical(row.dataJson);
          if (
            data.relay?.viaEnvironmentId !== environment.id ||
            data.origin.environmentId !== row.relayedFrom ||
            Facts.factEventId(data.origin, data.factKey) !== input.eventId
          )
            return undefined;
          const requester = yield* access.requester({ ...input, environmentId: row.relayedFrom });
          const outgoing = yield* access.outgoing(row.relayedFrom);
          if (requester.verdict !== "allowed" || outgoing.verdict !== "allowed")
            return { decision: requester.verdict !== "allowed" ? requester : outgoing };
          if (
            requester.authorization.peerEnvironmentId !== row.relayedFrom ||
            outgoing.authorization.peerEnvironmentId !== row.relayedFrom
          )
            return undefined;
          const cursor = yield* peerCursor(row.relayedFrom);
          if (
            cursor === undefined ||
            cursor.authorizationGeneration === null ||
            cursor.status !== "following"
          )
            return undefined;
          return {
            row,
            data,
            requester: requester.authorization,
            outgoing: outgoing.authorization,
            cursor,
          };
        }),
      );
      if (prepared === undefined) return unavailableProof;
      if ("decision" in prepared) return { ...unavailableProof, decision: prepared.decision };
      const reference: Wire.AgentFactRelayReference = {
        eventId: input.eventId,
        originGeneration: prepared.data.origin.sourceGeneration,
        threadId: typeof prepared.data.thread?.id === "string" ? prepared.data.thread.id : null,
      };
      const response = yield* transport.validate({
        authorization: {
          ...prepared.outgoing,
          limits: narrowLimits(prepared.outgoing.limits, prepared.requester.limits),
        },
        request: {
          references: [reference],
          authorizationGeneration: prepared.cursor.authorizationGeneration,
        },
      });
      const proof = yield* decodeProof(response, {
        onExcessProperty: "error",
      });
      if (
        proof.authorizationGeneration !== prepared.cursor.authorizationGeneration ||
        proof.results.length !== 1 ||
        !same(proof.results[0]!.reference, reference)
      )
        return unavailableProof;
      return yield* access.withGate(
        Effect.gen(function* () {
          const requester = yield* access.requester({
            ...input,
            environmentId: prepared.row.relayedFrom!,
          });
          const outgoing = yield* access.outgoing(prepared.row.relayedFrom!);
          if (requester.verdict !== "allowed" || outgoing.verdict !== "allowed")
            return {
              ...unavailableProof,
              decision: requester.verdict !== "allowed" ? requester : outgoing,
            };
          if (
            !same(requester.authorization, prepared.requester) ||
            !same(outgoing.authorization, prepared.outgoing) ||
            !same(yield* findFact(input.eventId), prepared.row) ||
            (yield* peerCursor(prepared.row.relayedFrom!))?.authorizationGeneration !==
              prepared.cursor.authorizationGeneration
          )
            return unavailableProof;
          return {
            decision: proof.results[0]!.decision,
            checkedAt: proof.checkedAt,
            originAuthorizationGeneration: proof.authorizationGeneration,
            authorizationGeneration: requester.authorization.generation,
          };
        }),
      );
    },
    Effect.catchCause(() => Effect.succeed(unavailableProof)),
  );

  return AgentFactRelay.of({
    readOrigin: Effect.fn("AgentFactRelay.readOriginChecked")((input) =>
      readOrigin(input).pipe(
        Effect.mapError(storageError),
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    ),
    validateOrigin: Effect.fn("AgentFactRelay.validateOriginChecked")((input) =>
      validateOrigin(input).pipe(
        Effect.mapError(storageError),
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    ),
    followOnce: Effect.fn("AgentFactRelay.followOnceChecked")((environmentId, waitMs) =>
      followOnce(environmentId, waitMs).pipe(
        Effect.mapError(storageError),
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    ),
    peerCursor: Effect.fn("AgentFactRelay.peerCursorChecked")((environmentId) =>
      peerCursor(environmentId).pipe(Effect.mapError(storageError)),
    ),
    checkCached: Effect.fn("AgentFactRelay.checkCachedChecked")((input) =>
      checkCached(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
  });
});
export const layer = (environment: { readonly id: string; readonly label: string }) =>
  Layer.effect(AgentFactRelay, make(environment));
