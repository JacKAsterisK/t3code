// @effect-diagnostics nodeBuiltinImport:off -- the harness ages a secret file on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { makeProbe } from "../cli/agentEvents.ts";
import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentEventDelivery from "./AgentEventDelivery.ts";
import {
  allowed,
  layerAuthority,
  layerFileDatabase,
  type ReceivedRequest,
  receiverTransport,
  StandardWebhook,
  startReceiver,
  testSecret,
} from "./AgentEvents.testkit.ts";
import type * as AgentEventAuthority from "./AgentEventAuthority.ts";
import * as Store from "./AgentEventStore.ts";
import { subscribe } from "./AgentEventSubscriptions.ts";
import { WebhookTransport } from "./WebhookSender.ts";

/**
 * Phase 0's local harness: a real HTTPS callback that verifies every signature with the
 * independent standardwebhooks library, `events/subscribe` with a real verification, the CLI's
 * probe, and the real delivery worker, restarted on the same database.
 */

const secret = testSecret(5);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:buildmachine"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "client:session-dot",
  thread: undefined,
  client: {
    sessionId: "session-dot",
    label: "Gecko Butler",
    access: "approval-required",
    sharesOutside: true,
  },
};

interface Probe {
  readonly eventId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly cursor: string;
  readonly data: {
    readonly kind: string;
    readonly schema: string;
    readonly textIsUntrusted: boolean;
    readonly detail: { readonly nonce: string; readonly subscriptionId: string };
  };
}

const events = (received: ReadonlyArray<ReceivedRequest>) =>
  received.flatMap((request) => {
    const body = JSON.parse(request.body) as Probe | { type: string };
    if ("type" in body) return [];
    // Throws unless the exact bytes carry a valid, fresh signature.
    new StandardWebhook(secret).verify(request.body, request.headers);
    assert.strictEqual(request.headers["webhook-id"], body.eventId);
    return [body];
  });

describe("agent events harness", () => {
  it.live("subscribe, probe, resend across a restart with the same event id, 413 and 410", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-events-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const receiver = yield* startReceiver();
        const verdicts = yield* Ref.make<ReadonlyMap<string, AgentEventAuthority.AuthorityVerdict>>(
          new Map([["session-dot", allowed()]]),
        );
        const shared = Layer.mergeAll(
          layerFileDatabase(NodePath.join(directory, "state.sqlite")),
          ServerSecretStore.layer,
          layerAuthority(verdicts),
          Layer.succeed(WebhookTransport, receiverTransport(receiver.ca)),
          ServerSettings.layerTest({ agentEventsEnabled: true }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "t3",
            legacyCookieName: undefined,
            streamChanges: Stream.empty,
          }),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), NodePath.join(directory, "home")),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
        const services = yield* Layer.build(shared);
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provide(services));
        // A server generation: the worker runs until its scope closes.
        const startServer = Effect.gen(function* () {
          const generation = yield* Scope.make();
          yield* Layer.buildWithScope(AgentEventDelivery.layer, generation).pipe(
            Effect.provide(services),
          );
          return generation;
        });

        const url = `https://callback.test:${receiver.port}/t3`;
        const subscribed = yield* provide(
          subscribe(scope, {
            name: "t3.task_activity",
            arguments: {},
            delivery: { mode: "webhook", url, secret },
            cursor: null,
          }),
        );
        assert.strictEqual(
          (JSON.parse(receiver.received[0]!.body) as { type: string }).type,
          "verification",
        );
        new StandardWebhook(secret).verify(
          receiver.received[0]!.body,
          receiver.received[0]!.headers,
        );

        // The CLI's probe, through the store a second process would use.
        const queue = (nonce: string) =>
          provide(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const probe = makeProbe({
                environmentId: "environment:buildmachine",
                environmentLabel: "BuildMachine",
                subscriptionId: subscribed.id,
                nonce,
                note: null,
                occurredAt: now,
              });
              yield* Store.appendProbe({
                eventId: probe.eventId,
                subscriptionId: subscribed.id,
                occurredAt: now,
                dataJson: probe.dataJson,
                now,
              });
              return probe.eventId;
            }),
          );

        // The receiver answers by nonce; the first wake-1 attempt never gets an answer.
        let hangFirst = true;
        receiver.respond.current = (request) => {
          if (request.body.includes(`"type":"verification"`)) return { status: 200, body: "{}" };
          if (request.body.includes(`"nonce":"too-big"`)) return { status: 413, body: "{}" };
          if (request.body.includes(`"nonce":"gone"`)) return { status: 410, body: "{}" };
          if (hangFirst) {
            hangFirst = false;
            return "hang";
          }
          return { status: 200, body: "{}" };
        };
        // The next event the callback receives, as it arrives.
        const nextEvent: Effect.Effect<ReceivedRequest> = Queue.take(receiver.requests).pipe(
          Effect.filterOrElse(
            (request) => !request.body.includes(`"type":"verification"`),
            () => nextEvent,
          ),
        );
        const deliveryState = (eventId: string) =>
          provide(Store.findDelivery(subscribed.id, eventId)).pipe(
            Effect.map((row) => [row?.state, row?.attempts]),
          );

        // First generation: the server stops while the first send is in flight.
        const first = yield* startServer;
        const eventId = yield* queue("wake-1");
        assert.strictEqual((yield* nextEvent).headers["webhook-id"], eventId);
        yield* Scope.close(first, Exit.void);
        assert.deepStrictEqual(yield* deliveryState(eventId), ["pending", 0]);

        // Second generation on the same database resends the same event.
        const second = yield* startServer;
        assert.strictEqual((yield* nextEvent).headers["webhook-id"], eventId);
        // One event in flight per subscription: the next one arriving means the last finished.
        const rejected = yield* queue("too-big");
        assert.strictEqual((yield* nextEvent).headers["webhook-id"], rejected);
        assert.deepStrictEqual(yield* deliveryState(eventId), ["delivered", 1]);
        const milestone = yield* queue("after-413");
        assert.strictEqual((yield* nextEvent).headers["webhook-id"], milestone);
        // 413: rejected after one attempt and never retried.
        assert.deepStrictEqual(yield* deliveryState(rejected), ["rejected", 1]);
        yield* Scope.close(second, Exit.void);

        const delivered = events(receiver.received).filter((event) => event.eventId === eventId);
        assert.strictEqual(delivered.length, 2);
        assert.strictEqual(delivered[0]!.timestamp, delivered[1]!.timestamp);
        const attempts = receiver.received.filter(
          (request) => request.headers["webhook-id"] === eventId,
        );
        // Each attempt is signed when sent (whole seconds), so a later second means a new signature.
        assert.strictEqual(
          attempts[0]!.headers["webhook-timestamp"] === attempts[1]!.headers["webhook-timestamp"],
          attempts[0]!.headers["webhook-signature"] === attempts[1]!.headers["webhook-signature"],
        );
        const [probe] = delivered;
        assert.strictEqual(probe!.name, "t3.task_activity");
        assert.strictEqual(probe!.data.kind, "probe");
        assert.strictEqual(probe!.data.schema, "t3.agent-event/1");
        assert.isTrue(probe!.data.textIsUntrusted);
        assert.strictEqual(probe!.data.detail.nonce, "wake-1");
        assert.strictEqual(probe!.data.detail.subscriptionId, subscribed.id);
        // The same nonce is the same event: nothing new is queued.
        assert.strictEqual(yield* queue("wake-1"), eventId);

        // 410, driven step by step over the same HTTPS callback: the subscription is gone and
        // nothing queued after it is sent.
        const gone = yield* queue("gone");
        yield* queue("never-sent");
        const outcomes = yield* provide(
          Effect.gen(function* () {
            yield* Store.resetSending(yield* Clock.currentTimeMillis);
            const results: Array<string> = [];
            for (;;) {
              const claims = yield* Store.claimDue(yield* Clock.currentTimeMillis, 4);
              if (claims.length === 0) return results;
              for (const claim of claims)
                results.push(
                  `${claim.eventId === gone ? "gone:" : ""}${yield* AgentEventDelivery.attempt(claim)}`,
                );
            }
          }),
        );
        assert.deepStrictEqual(outcomes.slice(-1), ["gone:gone"]);
        assert.strictEqual((yield* provide(Store.findSubscription(subscribed.id)))!.state, "gone");
        assert.strictEqual(
          receiver.received.filter((request) => request.body.includes(`"nonce":"never-sent"`))
            .length,
          0,
        );
      }),
    ),
  );

  it.live("startup removes secret files no subscription names", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-events-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const layer = Layer.mergeAll(
          layerFileDatabase(NodePath.join(directory, "state.sqlite")),
          ServerSecretStore.layer,
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), NodePath.join(directory, "home")),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const config = yield* ServerConfig.ServerConfig;
          yield* secrets.create("agent-events-orphan-old", new Uint8Array(32));
          yield* secrets.create("agent-events-orphan-new", new Uint8Array(32));
          yield* secrets.create("unrelated-secret", new Uint8Array(32));
          const old = NodePath.join(config.secretsDir, "agent-events-orphan-old.bin");
          const hourAgo = (yield* Clock.currentTimeMillis) / 1000 - 3_600;
          NodeFS.utimesSync(old, hourAgo, hourAgo);
          yield* AgentEventDelivery.removeOrphanSecrets();
          assert.strictEqual((yield* secrets.get("agent-events-orphan-old"))._tag, "None");
          // A file this young may belong to a subscribe still in progress.
          assert.strictEqual((yield* secrets.get("agent-events-orphan-new"))._tag, "Some");
          assert.strictEqual((yield* secrets.get("unrelated-secret"))._tag, "Some");
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
});
