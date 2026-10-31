import { assert, describe, it } from "@effect/vitest";
import {
  AgentEventsErrorCode,
  EnvironmentId,
  formatAgentEventCursor,
  parseAgentEventCursor,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  allowed,
  layerAuthority,
  layerDatabase,
  layerMemorySecrets,
  testSecret,
  type Verdicts,
} from "./AgentEvents.testkit.ts";
import type * as AgentEventAuthority from "./AgentEventAuthority.ts";
import * as Store from "./AgentEventStore.ts";
import { grantedTtlMs, subscribe, unsubscribe, EventsRpcError } from "./AgentEventSubscriptions.ts";
import { principalForSession, subscriptionIdFor } from "./identity.ts";
import { type PostOutcome, WebhookTransport } from "./WebhookSender.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const clientScope = (
  sessionId = "session-a",
  client: Partial<McpInvocationContext.McpClientCaller> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:buildmachine"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: {
    sessionId,
    label: "Gecko Butler",
    access: "approval-required",
    sharesOutside: true,
    ...client,
  },
});

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Echoes verification challenges; counts every POST. */
const makeHarness = Effect.gen(function* () {
  const posts = yield* Ref.make<
    ReadonlyArray<{ readonly body: string; readonly headers: Record<string, string> }>
  >([]);
  const answer = yield* Ref.make<"echo" | PostOutcome>("echo");
  const verdicts: Verdicts = yield* Ref.make<
    ReadonlyMap<string, AgentEventAuthority.AuthorityVerdict>
  >(
    new Map([
      ["session-a", allowed()],
      ["session-b", allowed()],
    ]),
  );
  const transport = WebhookTransport.of({
    post: ({ body, headers }) =>
      Effect.gen(function* () {
        yield* Ref.update(posts, (all) => [...all, { body, headers: { ...headers } }]);
        const mode = yield* Ref.get(answer);
        if (mode !== "echo") return mode;
        const parsed = decodeJson(body) as { challenge?: string };
        return {
          _tag: "Response",
          status: 200,
          retryAfter: undefined,
          body: JSON.stringify({ challenge: parsed.challenge }),
          remoteAddress: "203.0.113.1",
        } as const;
      }),
  });
  return { posts, answer, verdicts, transport };
});

const run = <A, E>(
  body: (
    harness: Effect.Success<typeof makeHarness>,
  ) => Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | ServerSecretStore.ServerSecretStore
    | AgentEventAuthority.AgentEventAuthority
    | WebhookTransport
  >,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    return yield* body(harness).pipe(
      Effect.provide(
        Layer.mergeAll(layerDatabase, layerMemorySecrets, layerAuthority(harness.verdicts)),
      ),
      Effect.provideService(WebhookTransport, harness.transport),
    );
  });

const params = (overrides: Record<string, unknown> = {}) => ({
  name: "t3.task_activity",
  arguments: {},
  delivery: { mode: "webhook", url: "https://hooks.example.com/t3", secret: testSecret(7) },
  cursor: null,
  ...overrides,
});

const rpcError = <A, R>(effect: Effect.Effect<A, EventsRpcError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => ({ code: error.code, data: error.data })));

const now = 1_800_000_000_000;

describe("events/subscribe", () => {
  it.effect(
    "derives the same id whatever the argument key order, and re-subscribing is idempotent",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(now);
          const first = yield* subscribe(
            clientScope(),
            params({ arguments: { threadIds: ["t1"], includeDelegatedResults: true } }),
          );
          const second = yield* subscribe(
            clientScope(),
            params({ arguments: { includeDelegatedResults: true, threadIds: ["t1"] } }),
          );
          assert.strictEqual(first.id, second.id);
          assert.match(first.id, /^sub_[A-Za-z0-9_-]{32}$/u);
          assert.strictEqual(
            first.id,
            subscriptionIdFor({
              principalId: principalForSession("session-a"),
              url: "https://hooks.example.com/t3",
              name: "t3.task_activity",
              arguments: { threadIds: ["t1"], includeDelegatedResults: true },
            }),
          );
          assert.strictEqual((yield* Store.listSubscriptions()).length, 1);
          // Verified once; the second call reuses the 24-hour verification.
          assert.strictEqual((yield* Ref.get(harness.posts)).length, 1);
          assert.isFalse(first.truncated);
          assert.strictEqual(parseAgentEventCursor(first.cursor)?.sequence, 0);
        }),
      ),
  );

  it.effect(
    "keeps two sign-ins of the same app apart: each session owns its own subscription",
    () =>
      run(() =>
        Effect.gen(function* () {
          yield* TestClock.setTime(now);
          const a = yield* subscribe(clientScope("session-a"), params());
          const b = yield* subscribe(clientScope("session-b"), params());
          assert.notStrictEqual(a.id, b.id);
          // Unsubscribing from one session never touches the other's.
          yield* unsubscribe(
            clientScope("session-b"),
            params({ delivery: { mode: "webhook", url: "https://hooks.example.com/t3" } }),
          );
          assert.strictEqual((yield* Store.findSubscription(a.id))?.state, "active");
          assert.strictEqual((yield* Store.findSubscription(b.id))?.state, "unsubscribed");
        }),
      ),
  );

  it.effect("grants a finite TTL within bounds and never past the session", () =>
    run((harness) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const at = (iso: string) => Date.parse(iso) - now;
        assert.strictEqual(at((yield* subscribe(clientScope(), params())).refreshBefore), DAY);
        assert.strictEqual(
          at((yield* subscribe(clientScope(), params({ ttlMs: null }))).refreshBefore),
          DAY,
        );
        assert.strictEqual(
          at((yield* subscribe(clientScope(), params({ ttlMs: 60_000 }))).refreshBefore),
          HOUR,
        );
        assert.strictEqual(
          at((yield* subscribe(clientScope(), params({ ttlMs: 30 * DAY }))).refreshBefore),
          7 * DAY,
        );
        yield* Ref.set(harness.verdicts, new Map([["session-a", allowed(now + 2 * HOUR)]]));
        assert.strictEqual(
          at((yield* subscribe(clientScope(), params({ ttlMs: 5 * DAY }))).refreshBefore),
          2 * HOUR,
        );
        assert.strictEqual(grantedTtlMs(undefined, 10 * DAY), DAY);
        assert.strictEqual(grantedTtlMs("1h", 10 * DAY), DAY);
      }),
    ),
  );

  it.effect("rejects an owner filter and other unknown arguments", () =>
    run(() =>
      Effect.gen(function* () {
        const error = yield* rpcError(
          subscribe(clientScope(), params({ arguments: { owner: "dan" } })),
        );
        assert.strictEqual(error.code, AgentEventsErrorCode.invalidParams);
        for (const bad of [
          { name: "t3.everything" },
          { arguments: { threadIds: "t1" } },
          { arguments: { threadIds: Array.from({ length: 51 }, (_, index) => `t${index}`) } },
          { arguments: { includeDelegatedResults: "yes" } },
          { delivery: { mode: "poll", url: "https://hooks.example.com/t3", secret: testSecret() } },
          {
            delivery: {
              mode: "webhook",
              url: "https://hooks.example.com/t3",
              secret: "not-a-secret",
            },
          },
          { cursor: 7 },
          { cursor: "c2.whatever.1" },
          { ttlMs: "1h" },
        ])
          assert.strictEqual(
            (yield* rpcError(subscribe(clientScope(), params(bad)))).code,
            AgentEventsErrorCode.invalidParams,
            JSON.stringify(bad),
          );
        assert.strictEqual((yield* Store.listSubscriptions()).length, 0);
      }),
    ),
  );

  it.effect("refuses non-https callbacks and failed verification as CallbackEndpointError", () =>
    run((harness) =>
      Effect.gen(function* () {
        const insecure = yield* rpcError(
          subscribe(
            clientScope(),
            params({
              delivery: {
                mode: "webhook",
                url: "http://hooks.example.com/t3",
                secret: testSecret(),
              },
            }),
          ),
        );
        assert.deepStrictEqual(insecure, {
          code: AgentEventsErrorCode.callbackEndpoint,
          data: { reason: "invalid_url" },
        });
        yield* Ref.set(harness.answer, { _tag: "Failed", reason: "address_refused" });
        assert.deepStrictEqual(yield* rpcError(subscribe(clientScope(), params())), {
          code: AgentEventsErrorCode.callbackEndpoint,
          data: { reason: "address_refused" },
        });
        yield* Ref.set(harness.answer, {
          _tag: "Response",
          status: 200,
          retryAfter: undefined,
          body: "{}",
          remoteAddress: undefined,
        });
        assert.deepStrictEqual(yield* rpcError(subscribe(clientScope(), params())), {
          code: AgentEventsErrorCode.callbackEndpoint,
          data: { reason: "challenge_failed" },
        });
        assert.strictEqual((yield* Store.listSubscriptions()).length, 0);
      }),
    ),
  );

  it.effect("refuses callers that may not hand data outside the fleet, failing closed", () =>
    run((harness) =>
      Effect.gen(function* () {
        const forbidden = { code: AgentEventsErrorCode.forbidden, data: undefined };
        const thread: McpInvocationContext.McpInvocationScope = {
          ...clientScope(),
          thread: {
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "p",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
        };
        assert.deepStrictEqual(yield* rpcError(subscribe(thread, params())), forbidden);
        assert.deepStrictEqual(
          yield* rpcError(subscribe(clientScope("session-a", { linked: true }), params())),
          forbidden,
        );
        assert.deepStrictEqual(
          yield* rpcError(
            subscribe(clientScope("session-a", { taskOnly: true, grantId: "g" }), params()),
          ),
          forbidden,
        );
        assert.deepStrictEqual(
          yield* rpcError(subscribe(clientScope("session-a", { sharesOutside: false }), params())),
          forbidden,
        );
        for (const reason of [
          "outside_sharing_refused",
          "fleet_read_only",
          "read_scope_lost",
          "session_inactive",
        ] as const) {
          yield* Ref.set(harness.verdicts, new Map([["session-a", { _tag: "Refused", reason }]]));
          assert.deepStrictEqual(
            yield* rpcError(subscribe(clientScope(), params())),
            forbidden,
            reason,
          );
        }
        yield* Ref.set(harness.verdicts, new Map([["session-a", { _tag: "Unavailable" }]]));
        assert.strictEqual(
          (yield* rpcError(subscribe(clientScope(), params()))).code,
          AgentEventsErrorCode.internal,
        );
        // Nothing was verified or stored for any of them.
        assert.strictEqual((yield* Ref.get(harness.posts)).length, 0);
        assert.strictEqual((yield* Store.listSubscriptions()).length, 0);
      }),
    ),
  );

  it.effect("a refresh rebinds the session and a new secret overlaps the old for 10 minutes", () =>
    run(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const first = yield* subscribe(clientScope(), params());
        const before = (yield* Store.findSubscription(first.id))!;
        yield* TestClock.setTime(now + HOUR);
        yield* subscribe(
          clientScope(),
          params({
            delivery: {
              mode: "webhook",
              url: "https://hooks.example.com/t3",
              secret: testSecret(9),
            },
          }),
        );
        const after = (yield* Store.findSubscription(first.id))!;
        assert.notStrictEqual(after.secretRef, before.secretRef);
        assert.strictEqual(after.previousSecretRef, before.secretRef);
        assert.strictEqual(after.previousSecretUntil, now + HOUR + 10 * 60_000);
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        assert.isTrue((yield* secrets.get(before.secretRef))._tag === "Some");
        // Retiring the previous secret deletes it.
        const retired = yield* Store.retirePreviousSecrets(now + HOUR + 10 * 60_000);
        assert.deepStrictEqual(retired, [before.secretRef]);
        // The same secret again keeps the current name.
        yield* subscribe(
          clientScope(),
          params({
            delivery: {
              mode: "webhook",
              url: "https://hooks.example.com/t3",
              secret: testSecret(9),
            },
          }),
        );
        assert.strictEqual((yield* Store.findSubscription(first.id))!.secretRef, after.secretRef);
      }),
    ),
  );

  it.effect("unsubscribe is idempotent, drops queued events and deletes the secret", () =>
    run(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const sub = yield* subscribe(clientScope(), params());
        yield* Store.appendProbe({
          eventId: "t3e1_a",
          subscriptionId: sub.id,
          occurredAt: now,
          dataJson: "{}",
          now,
        });
        const row = (yield* Store.findSubscription(sub.id))!;
        const target = params({
          delivery: { mode: "webhook", url: "https://hooks.example.com/t3" },
        });
        assert.deepStrictEqual(yield* unsubscribe(clientScope(), target), {});
        assert.deepStrictEqual(yield* unsubscribe(clientScope(), target), {});
        assert.strictEqual((yield* Store.findSubscription(sub.id))!.state, "unsubscribed");
        assert.deepStrictEqual(yield* Store.deliveryCounts(sub.id), {});
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        assert.isTrue((yield* secrets.get(row.secretRef))._tag === "None");
        // Another principal's unsubscribe names a different subscription: nothing happens.
        assert.deepStrictEqual(yield* unsubscribe(clientScope("session-b"), target), {});
      }),
    ),
  );
});

describe("cursors, replay and truncated", () => {
  const probe = (subscriptionId: string, eventId: string, at: number) =>
    Store.appendProbe({ eventId, subscriptionId, occurredAt: at, dataJson: "{}", now: at });

  it.effect("null starts at the head; a cursor ahead of the head is refused", () =>
    run(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const sub = yield* subscribe(clientScope(), params());
        yield* probe(sub.id, "t3e1_1", now);
        const { epoch, headSeq } = yield* Store.logState();
        assert.strictEqual(headSeq, 1);
        const ahead = yield* rpcError(
          subscribe(clientScope(), params({ cursor: formatAgentEventCursor(epoch, 2) })),
        );
        assert.strictEqual(ahead.code, AgentEventsErrorCode.invalidParams);
        // The queued probe holds the cursor below it.
        const refreshed = yield* subscribe(clientScope(), params());
        assert.strictEqual(refreshed.cursor, formatAgentEventCursor(epoch, 0));
      }),
    ),
  );

  it.effect("replay below the delivered watermark requeues and moves the cursor back", () =>
    run(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const sub = yield* subscribe(clientScope(), params());
        for (const id of ["t3e1_1", "t3e1_2", "t3e1_3"]) yield* probe(sub.id, id, now);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_event_deliveries SET state = 'delivered', finished_at = ${now}`;
        yield* Store.recomputeWatermark(sub.id, now);
        const { epoch } = yield* Store.logState();
        const caughtUp = yield* subscribe(
          clientScope(),
          params({ cursor: formatAgentEventCursor(epoch, 3) }),
        );
        assert.strictEqual(caughtUp.cursor, formatAgentEventCursor(epoch, 3));
        assert.isFalse(caughtUp.truncated);

        // The client lost 2 and 3: they go again, and the cursor never claims past them.
        const replay = yield* subscribe(
          clientScope(),
          params({ cursor: formatAgentEventCursor(epoch, 1) }),
        );
        assert.strictEqual(replay.cursor, formatAgentEventCursor(epoch, 1));
        assert.isFalse(replay.truncated);
        const states = (yield* Store.listDeliveries(sub.id, 10)).map((row) => [
          row.logSeq,
          row.state,
        ]);
        assert.deepStrictEqual(states, [
          [3, "pending"],
          [2, "pending"],
          [1, "delivered"],
        ]);
      }),
    ),
  );

  it.effect("a foreign epoch or a cursor below the floor replays what is retained, truncated", () =>
    run(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const sub = yield* subscribe(clientScope(), params());
        yield* probe(sub.id, "t3e1_1", now);
        yield* probe(sub.id, "t3e1_2", now);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_event_deliveries SET state = 'delivered', finished_at = ${now}`;
        // Retention drops the first event.
        yield* sql`UPDATE agent_event_probes SET created_at = ${now - 15 * DAY} WHERE log_seq = 1`;
        yield* Store.prune(now);
        const { epoch, floorSeq } = yield* Store.logState();
        assert.strictEqual(floorSeq, 2);

        const below = yield* subscribe(
          clientScope(),
          params({ cursor: formatAgentEventCursor(epoch, 0) }),
        );
        assert.isTrue(below.truncated);
        assert.strictEqual(below.cursor, formatAgentEventCursor(epoch, 1));
        const foreign = yield* subscribe(
          clientScope(),
          params({ cursor: formatAgentEventCursor("otherEpoch1", 5) }),
        );
        assert.isTrue(foreign.truncated);
        assert.strictEqual(foreign.cursor, formatAgentEventCursor(epoch, 1));
        assert.deepStrictEqual(
          (yield* Store.listDeliveries(sub.id, 10)).map((row) => [row.logSeq, row.state]),
          // The pruned event's finished delivery row is kept for its own 7 days.
          [
            [2, "pending"],
            [1, "delivered"],
          ],
        );
      }),
    ),
  );

  it.effect("retention keeps an event a delivery still needs", () =>
    run(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const sub = yield* subscribe(clientScope(), params());
        yield* probe(sub.id, "t3e1_1", now - 20 * DAY);
        // An old payload replayed now still has its full 48-hour delivery horizon.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_event_deliveries SET queued_at = ${now}, next_attempt_at = ${now}`;
        yield* Store.prune(now);
        assert.isDefined(yield* Store.loadEvent(1));
        assert.strictEqual((yield* Store.logState()).floorSeq, 1);
      }),
    ),
  );
});
