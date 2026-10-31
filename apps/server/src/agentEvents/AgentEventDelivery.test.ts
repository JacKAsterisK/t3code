import { assert, describe, it } from "@effect/vitest";
import { formatAgentEventCursor, type ServerSettings as Settings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  allowed,
  layerAuthority,
  layerDatabase,
  layerMemorySecrets,
  testSecret,
  type Verdicts,
} from "./AgentEvents.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentEventAuthority from "./AgentEventAuthority.ts";
import * as AgentEventDelivery from "./AgentEventDelivery.ts";
import * as Store from "./AgentEventStore.ts";
import { decodeWebhookSecret } from "./identity.ts";
import { type PostOutcome, WebhookTransport } from "./WebhookSender.ts";

const HOUR = 3_600_000;
const start = 1_800_000_000_000;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const respond = (status: number, retryAfter?: string): PostOutcome => ({
  _tag: "Response",
  status,
  retryAfter,
  body: "",
  remoteAddress: "203.0.113.1",
});

const harness = Effect.gen(function* () {
  const posts = yield* Ref.make<
    ReadonlyArray<{ readonly body: string; readonly headers: Record<string, string> }>
  >([]);
  const script = yield* Ref.make<ReadonlyArray<PostOutcome>>([]);
  const verdicts: Verdicts = yield* Ref.make<
    ReadonlyMap<string, AgentEventAuthority.AuthorityVerdict>
  >(new Map([["session-a", allowed()]]));
  const transport = WebhookTransport.of({
    post: ({ body, headers }) =>
      Effect.gen(function* () {
        yield* Ref.update(posts, (all) => [...all, { body, headers: { ...headers } }]);
        const [next, ...rest] = yield* Ref.get(script);
        yield* Ref.set(script, rest);
        return next ?? respond(200);
      }),
  });
  return { posts, script, verdicts, transport };
});

type Harness = Effect.Success<typeof harness>;

const run = <A, E>(
  body: (
    h: Harness,
  ) => Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | ServerSecretStore.ServerSecretStore
    | AgentEventAuthority.AgentEventAuthority
    | WebhookTransport
    | ServerSettings.ServerSettingsService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | SessionStore.SessionStore
  >,
) =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* TestClock.setTime(start);
    return yield* body(h).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerDatabase,
          layerMemorySecrets,
          layerAuthority(h.verdicts),
          ServerSettings.layerTest({ agentEventsEnabled: true }),
          Layer.mock(ServerConfig.ServerConfig)({
            secretsDir: "unused-agent-events-test-secrets",
          } as ServerConfig.ServerConfig["Service"]),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "t3",
            legacyCookieName: undefined,
            streamChanges: Stream.empty,
          }),
          FileSystem.layerNoop({ readDirectory: () => Effect.succeed([]) }),
        ),
      ),
      Effect.provideService(WebhookTransport, h.transport),
    );
  });

const SUB = "sub_test";

const subscribeRow = (overrides: Partial<Store.SubscriptionWrite> = {}) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.create("agent-events-current", decodeWebhookSecret(testSecret(7))!);
    const { epoch, headSeq } = yield* Store.logState();
    yield* Store.upsertSubscription(
      {
        subscriptionId: SUB,
        principalId: "session:session-a",
        sessionId: "session-a",
        attributionSubject: "mcp-client:local",
        clientLabel: "Gecko Butler",
        eventName: "t3.task_activity",
        argumentsJson: "{}",
        callbackUrl: "https://hooks.example.com/t3",
        secretRef: "agent-events-current",
        previousSecretRef: null,
        previousSecretUntil: null,
        state: "active",
        expiresAt: start + 24 * HOUR,
        logEpoch: epoch,
        updatedAt: start,
        ...overrides,
      },
      headSeq,
    );
    return epoch;
  });

const probe = (eventId: string, dataJson = `{"kind":"probe","nonce":"${eventId}"}`) =>
  Store.appendProbe({ eventId, subscriptionId: SUB, occurredAt: start, dataJson, now: start });

/** Claims what is due now and attempts each claim. */
const deliverDue = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const claims = yield* Store.claimDue(now, 4);
  return yield* Effect.forEach(claims, AgentEventDelivery.attempt);
});

const deliveryOf = (eventId: string) =>
  Store.findDelivery(SUB, eventId).pipe(Effect.map((row) => row!));

describe("delivery schedule", () => {
  it("backs off 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, then 8 h", () => {
    assert.deepStrictEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(AgentEventDelivery.backoffMs),
      [
        5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000,
        28_800_000,
      ],
    );
  });

  it("reads Retry-After as seconds or a date, within 5 s and 8 h", () => {
    assert.strictEqual(AgentEventDelivery.retryAfterMs("120", 0), 120_000);
    assert.strictEqual(AgentEventDelivery.retryAfterMs("0", 0), 5_000);
    assert.strictEqual(AgentEventDelivery.retryAfterMs("999999", 0), 28_800_000);
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.strictEqual(
      AgentEventDelivery.retryAfterMs("Fri, 30 Oct 2026 12:01:00 GMT", now),
      60_000,
    );
    assert.isUndefined(AgentEventDelivery.retryAfterMs("soon", now));
    assert.isUndefined(AgentEventDelivery.retryAfterMs(undefined, now));
  });
});

describe("AgentEventDelivery worker", () => {
  it.effect.each(["disable", "shutdown"] as const)(
    "%s cancels worker sends and releases their claims",
    (stop) =>
      run((h) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* subscribeRow();
            yield* probe("t3e1_a");
            const settings = yield* ServerSettings.ServerSettingsService;
            const started = yield* Deferred.make<void>();
            const changes = yield* Queue.unbounded<{
              readonly settings: Settings;
              readonly handled: Deferred.Deferred<void>;
            }>();
            const stream = Stream.fromQueue(changes).pipe(
              Stream.flatMap((change) =>
                Stream.concat(
                  Stream.succeed(change.settings),
                  Stream.fromEffectDrain(Deferred.succeed(change.handled, undefined)),
                ),
              ),
            );
            let cancelled = 0;
            let hang = true;
            const transport = WebhookTransport.of({
              post: (input) =>
                hang
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(
                        Effect.sync(() => {
                          cancelled += 1;
                        }),
                      ),
                    )
                  : h.transport.post(input),
            });
            const generation = yield* Scope.make();
            yield* Effect.addFinalizer((exit) => Scope.close(generation, exit));
            yield* Layer.buildWithScope(AgentEventDelivery.layer, generation).pipe(
              Effect.provideService(WebhookTransport, transport),
              Effect.provideService(ServerSettings.ServerSettingsService, {
                ...settings,
                subscribeChanges: Effect.succeed(stream),
              }),
            );
            yield* Deferred.await(started);
            assert.deepStrictEqual(yield* Store.claimDue(start, 4), []);
            if (stop === "shutdown") yield* Scope.close(generation, Exit.void);
            else {
              const current = yield* settings.updateSettings({ agentEventsEnabled: false });
              const handled = yield* Deferred.make<void>();
              yield* Queue.offer(changes, { settings: current, handled });
              yield* Deferred.await(handled);
            }
            assert.strictEqual(cancelled, 1);
            assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "pending");
            assert.strictEqual((yield* deliveryOf("t3e1_a")).attempts, 0);
            assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
            if (stop === "disable") {
              yield* TestClock.adjust("31 seconds");
              assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
              hang = false;
              const current = yield* settings.updateSettings({ agentEventsEnabled: true });
              const handled = yield* Deferred.make<void>();
              yield* Queue.offer(changes, { settings: current, handled });
              yield* Deferred.await(handled);
              yield* TestClock.adjust("1 second");
              assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "delivered");
              assert.strictEqual((yield* Ref.get(h.posts)).length, 1);
            }
          }),
        ),
      ),
  );

  it.effect.each([false, true])(
    "retries a transient secret read without restarting (cleanup fails: %s)",
    (cleanupFails) =>
      run((h) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* subscribeRow();
            yield* probe("t3e1_a");
            const secrets = yield* ServerSecretStore.ServerSecretStore;
            yield* subscribeRow({ subscriptionId: "sub_live", secretRef: "agent-events-live" });
            yield* secrets.create("agent-events-live", decodeWebhookSecret(testSecret(8))!);
            yield* Store.appendProbe({
              subscriptionId: "sub_live",
              eventId: "t3e1_live",
              occurredAt: start,
              dataJson: "{}",
              now: start,
            });
            const liveStarted = yield* Deferred.make<void>();
            let liveSends = 0;
            const transport = WebhookTransport.of({
              post: (input) =>
                input.headers["webhook-id"] === "t3e1_live"
                  ? Effect.sync(() => {
                      liveSends += 1;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(liveStarted, undefined)),
                      Effect.andThen(Effect.never),
                    )
                  : h.transport.post(input),
            });
            const sql = yield* SqlClient.SqlClient;
            const attempts = yield* Queue.unbounded<void>();
            let reads = 0;
            let cleanupFailures = 0;
            const tracer = Tracer.make({
              span: (options) => {
                const span = new Tracer.NativeSpan(options);
                const end = span.end.bind(span);
                span.end = (...args) => {
                  end(...args);
                  if (span.name === "AgentEventDelivery.attempt")
                    Queue.offerUnsafe(attempts, undefined);
                  if (span.name === "AgentEventStore.finishAttempt" && args[1]._tag === "Failure")
                    cleanupFailures += 1;
                };
                return span;
              },
            });
            if (cleanupFails)
              yield* sql`
          CREATE TEMP TRIGGER fail_claim_cleanup BEFORE UPDATE OF state ON agent_event_deliveries
          WHEN OLD.state = 'sending' AND NEW.state = 'pending'
          BEGIN SELECT RAISE(FAIL, 'injected cleanup failure'); END`;
            yield* Layer.build(AgentEventDelivery.layer).pipe(
              Effect.provideService(WebhookTransport, transport),
              Effect.provideService(ServerSecretStore.ServerSecretStore, {
                ...secrets,
                get: (name) =>
                  Effect.suspend(() =>
                    name === "agent-events-current" && ++reads === 1
                      ? Effect.fail(
                          new ServerSecretStore.SecretStoreReadError({
                            resource: "test event secret",
                            cause: new Error("injected read failure"),
                          }),
                        )
                      : secrets.get(name),
                  ),
              }),
              Effect.withTracer(tracer),
            );
            yield* Queue.take(attempts);
            yield* Deferred.await(liveStarted);
            yield* TestClock.adjust("1 second");
            if (cleanupFails) {
              assert.isAbove(cleanupFailures, 0);
              assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "sending");
              yield* sql`DROP TRIGGER fail_claim_cleanup`;
              yield* TestClock.adjust("1 second");
            }
            const released = yield* deliveryOf("t3e1_a");
            assert.strictEqual(released.state, "pending");
            assert.strictEqual(released.attempts, 0);
            assert.isAbove(released.nextAttemptAt, yield* Clock.currentTimeMillis);
            assert.strictEqual(reads, 1);
            assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
            yield* TestClock.adjust("31 seconds");
            yield* Queue.take(attempts);
            assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "delivered");
            assert.strictEqual(reads, 2);
            assert.strictEqual((yield* Ref.get(h.posts)).length, 1);
            assert.strictEqual(liveSends, 1);
            assert.strictEqual(
              (yield* Store.findDelivery("sub_live", "t3e1_live"))!.state,
              "sending",
            );
          }),
        ),
      ),
  );
});

describe("AgentEventDelivery.attempt", () => {
  it.effect("disabling events during authority checking stops an already claimed event", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        const settings = yield* ServerSettings.ServerSettingsService;
        const authority = AgentEventAuthority.AgentEventAuthority.of({
          check: () =>
            settings
              .updateSettings({ agentEventsEnabled: false })
              .pipe(Effect.as(allowed()), Effect.orDie),
        });
        assert.deepStrictEqual(
          yield* deliverDue.pipe(
            Effect.provideService(AgentEventAuthority.AgentEventAuthority, authority),
          ),
          ["skipped"],
        );
        assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "pending");
        assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
      }),
    ),
  );

  it.effect("delivers once, signing the stored event; the cursor moves past it", () =>
    run((h) =>
      Effect.gen(function* () {
        const epoch = yield* subscribeRow();
        yield* probe("t3e1_a");
        assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
        const [post] = yield* Ref.get(h.posts);
        assert.strictEqual(post!.headers["webhook-id"], "t3e1_a");
        assert.strictEqual(post!.headers["x-mcp-subscription-id"], SUB);
        assert.deepStrictEqual(decodeJson(post!.body), {
          eventId: "t3e1_a",
          name: "t3.task_activity",
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(start)),
          data: { kind: "probe", nonce: "t3e1_a" },
          cursor: formatAgentEventCursor(epoch, 1),
        });
        assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "delivered");
        assert.strictEqual((yield* Store.findSubscription(SUB))!.watermarkSeq, 1);
        assert.deepStrictEqual(yield* deliverDue, []);
      }),
    ),
  );

  it.effect("retries keep the event id, body and occurrence time; only the signature changes", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* Ref.set(h.script, [
          respond(500),
          { _tag: "Failed", reason: "timeout" },
          respond(204),
        ]);
        assert.deepStrictEqual(yield* deliverDue, ["retry"]);
        const first = yield* deliveryOf("t3e1_a");
        assert.strictEqual(first.state, "pending");
        assert.strictEqual(first.lastStatus, 500);
        assert.strictEqual(first.lastError, "http_500");
        const wait = first.nextAttemptAt - start;
        assert.isTrue(wait >= 4_000 && wait <= 6_000, `5 s ± 20%, got ${wait}`);
        // Not due yet.
        assert.deepStrictEqual(yield* deliverDue, []);
        yield* TestClock.adjust("6 seconds");
        assert.deepStrictEqual(yield* deliverDue, ["retry"]);
        const second = yield* deliveryOf("t3e1_a");
        assert.strictEqual(second.lastError, "timeout");
        assert.isTrue(second.nextAttemptAt - (start + 6_000) >= 24_000);
        yield* TestClock.adjust("40 seconds");
        assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
        const posts = yield* Ref.get(h.posts);
        assert.strictEqual(posts.length, 3);
        assert.strictEqual(new Set(posts.map((post) => post.body)).size, 1);
        assert.strictEqual(new Set(posts.map((post) => post.headers["webhook-id"])).size, 1);
        assert.strictEqual(new Set(posts.map((post) => post.headers["webhook-timestamp"])).size, 3);
        assert.strictEqual(new Set(posts.map((post) => post.headers["webhook-signature"])).size, 3);
        assert.strictEqual((yield* deliveryOf("t3e1_a")).attempts, 3);
      }),
    ),
  );

  it.effect("410 ends the subscription with no retry and drops what was queued", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* probe("t3e1_b");
        yield* Ref.set(h.script, [respond(410)]);
        assert.deepStrictEqual(yield* deliverDue, ["gone"]);
        const subscription = (yield* Store.findSubscription(SUB))!;
        assert.strictEqual(subscription.state, "gone");
        assert.deepStrictEqual(yield* Store.deliveryCounts(SUB), { rejected: 1 });
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        assert.strictEqual((yield* secrets.get("agent-events-current"))._tag, "None");
        yield* TestClock.adjust("1 day");
        assert.deepStrictEqual(yield* deliverDue, []);
        assert.strictEqual((yield* Ref.get(h.posts)).length, 1);
      }),
    ),
  );

  it.effect("413 rejects that event with no retry; the next one still goes", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* probe("t3e1_b");
        yield* Ref.set(h.script, [respond(413)]);
        assert.deepStrictEqual(yield* deliverDue, ["rejected"]);
        assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
        assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "rejected");
        yield* TestClock.adjust("1 day");
        assert.deepStrictEqual(yield* deliverDue, []);
        assert.strictEqual((yield* Store.findSubscription(SUB))!.watermarkSeq, 2);
      }),
    ),
  );

  it.effect("429 waits for Retry-After", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* Ref.set(h.script, [respond(429, "90")]);
        assert.deepStrictEqual(yield* deliverDue, ["retry"]);
        assert.strictEqual((yield* deliveryOf("t3e1_a")).nextAttemptAt, start + 90_000);
      }),
    ),
  );

  it.effect("an event still failing 48 hours after it was queued is abandoned", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow({ expiresAt: start + 7 * 24 * HOUR });
        yield* probe("t3e1_a");
        yield* Ref.set(
          h.script,
          Array.from({ length: 30 }, () => respond(503)),
        );
        let outcome = "";
        while (outcome !== "abandoned") {
          const results = yield* deliverDue;
          if (results.length > 0) outcome = results[0]!;
          yield* TestClock.adjust("1 hour");
        }
        const row = yield* deliveryOf("t3e1_a");
        assert.strictEqual(row.state, "abandoned");
        assert.isTrue(row.finishedAt! - start >= 48 * HOUR);
        assert.strictEqual((yield* Store.findSubscription(SUB))!.watermarkSeq, 1);
      }),
    ),
  );

  it.effect("a body over 256 KiB is rejected without sending", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_big", `{"blob":"${"x".repeat(262_144)}"}`);
        assert.deepStrictEqual(yield* deliverDue, ["rejected"]);
        assert.strictEqual((yield* deliveryOf("t3e1_big")).lastError, "body_too_large");
        assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
      }),
    ),
  );

  it.effect("revocation mid-retry stops delivery and drops the queue", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* Ref.set(h.script, [respond(500)]);
        assert.deepStrictEqual(yield* deliverDue, ["retry"]);
        yield* Ref.set(
          h.verdicts,
          new Map([["session-a", { _tag: "Refused", reason: "session_inactive" }]]),
        );
        yield* TestClock.adjust("10 seconds");
        assert.deepStrictEqual(yield* deliverDue, ["revoked"]);
        assert.strictEqual((yield* Store.findSubscription(SUB))!.state, "revoked");
        assert.deepStrictEqual(yield* Store.deliveryCounts(SUB), {});
        assert.strictEqual((yield* Ref.get(h.posts)).length, 1);
      }),
    ),
  );

  it.effect("an authority check that cannot finish sends nothing and tries again later", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* Ref.set(h.verdicts, new Map([["session-a", { _tag: "Unavailable" }]]));
        assert.deepStrictEqual(yield* deliverDue, ["deferred"]);
        const row = yield* deliveryOf("t3e1_a");
        assert.strictEqual(row.state, "pending");
        assert.strictEqual(row.attempts, 0);
        assert.strictEqual(row.nextAttemptAt, start + 30_000);
        assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
      }),
    ),
  );

  it.effect("delivery stops exactly at the granted expiry and resumes on a refresh", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow({ expiresAt: start + 60_000 });
        yield* TestClock.setTime(start + 60_000);
        yield* probe("t3e1_late");
        // At the expiry instant nothing is claimed.
        assert.deepStrictEqual(yield* deliverDue, []);
        assert.deepStrictEqual(
          (yield* Store.expireDue(start + 60_000)).map((row) => row.subscriptionId),
          [SUB],
        );
        assert.strictEqual((yield* Store.findSubscription(SUB))!.state, "expired");
        // Expiry keeps the queue, so a later subscribe resumes it.
        assert.deepStrictEqual(yield* Store.deliveryCounts(SUB), { pending: 1 });
        yield* subscribeRow({ expiresAt: start + 2 * HOUR });
        assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
        assert.strictEqual((yield* Ref.get(h.posts)).length, 1);
      }),
    ),
  );

  it.effect("a claim made just before expiry is released, not sent, once the grant runs out", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow({ expiresAt: start + 1_000 });
        yield* probe("t3e1_a");
        const claims = yield* Store.claimDue(start, 4);
        yield* TestClock.setTime(start + 1_000);
        assert.deepStrictEqual(yield* Effect.forEach(claims, AgentEventDelivery.attempt), [
          "skipped",
        ]);
        assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "pending");
        assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
      }),
    ),
  );

  it.effect(
    "one in flight per subscription; a restart resends an interrupted event with its id",
    () =>
      run((h) =>
        Effect.gen(function* () {
          yield* subscribeRow();
          yield* probe("t3e1_a");
          yield* probe("t3e1_b");
          const claims = yield* Store.claimDue(start, 4);
          assert.deepStrictEqual(claims, [{ subscriptionId: SUB, eventId: "t3e1_a" }]);
          assert.deepStrictEqual(yield* Store.claimDue(start, 4), []);
          // The process dies while t3e1_a is in flight.
          yield* Store.resetSending(start);
          assert.strictEqual((yield* deliveryOf("t3e1_a")).state, "pending");
          assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
          assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
          assert.deepStrictEqual(
            (yield* Ref.get(h.posts)).map((post) => post.headers["webhook-id"]),
            ["t3e1_a", "t3e1_b"],
          );
        }),
      ),
  );

  it.effect("a delivery's cursor never passes an earlier event still waiting to retry", () =>
    run((h) =>
      Effect.gen(function* () {
        const epoch = yield* subscribeRow();
        yield* probe("t3e1_a");
        yield* probe("t3e1_b");
        yield* Ref.set(h.script, [respond(500), respond(200)]);
        assert.deepStrictEqual(yield* deliverDue, ["retry"]);
        // t3e1_a backs off; t3e1_b is next and goes now.
        assert.deepStrictEqual(yield* deliverDue, ["delivered"]);
        const posts = yield* Ref.get(h.posts);
        assert.strictEqual(
          (decodeJson(posts[1]!.body) as { cursor: string }).cursor,
          formatAgentEventCursor(epoch, 0),
        );
        assert.strictEqual((yield* Store.findSubscription(SUB))!.watermarkSeq, 0);
      }),
    ),
  );

  it.effect("the sweep revokes an idle subscription whose session lost access", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* subscribeRow();
        yield* Ref.set(
          h.verdicts,
          new Map([["session-a", { _tag: "Refused", reason: "outside_sharing_refused" }]]),
        );
        yield* AgentEventDelivery.sweep();
        const row = (yield* Store.findSubscription(SUB))!;
        assert.strictEqual(row.state, "revoked");
        assert.strictEqual(row.endedReason, "outside_sharing_refused");
        assert.strictEqual((yield* Ref.get(h.posts)).length, 0);
      }),
    ),
  );

  it("splices the stored data into the body unchanged", () => {
    assert.strictEqual(
      AgentEventDelivery.deliveryBody({
        eventId: "t3e1_a",
        name: "t3.task_activity",
        occurredAt: 0,
        dataJson: `{"b":1,"a":"\\u00e9"}`,
        cursor: "c1.abcdefgh.3",
      }),
      `{"eventId":"t3e1_a","name":"t3.task_activity","timestamp":"1970-01-01T00:00:00.000Z","data":{"b":1,"a":"\\u00e9"},"cursor":"c1.abcdefgh.3"}`,
    );
  });
});
