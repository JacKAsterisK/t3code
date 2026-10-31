import { assert, describe, it } from "@effect/vitest";
import { isNonPublicAddress } from "@t3tools/shared/publicAddress";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";

import {
  receiverTransport,
  StandardWebhook,
  startReceiver,
  testSecret,
} from "./AgentEvents.testkit.ts";
import { constantTimeEqual, decodeWebhookSecret, webhookSignature } from "./identity.ts";
import {
  CallbackEndpointError,
  makeTransport,
  parseCallbackUrl,
  postSigned,
  redactCallbackUrl,
  signedHeaders,
  verifyCallback,
  WebhookTransport,
} from "./WebhookSender.ts";

const secret = testSecret(7);
const key = decodeWebhookSecret(secret)!;

const urlFor = (port: number, path = "/hooks/t3?token=abc") =>
  new URL(`https://callback.test:${port}${path}`);

describe("WebhookSender", () => {
  it.effect("verification still has its normal ten-second bound during DNS", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resolving = yield* Deferred.make<void>();
        const transport = makeTransport({
          refuses: isNonPublicAddress,
          resolve: () => {
            Deferred.doneUnsafe(resolving, Effect.void);
            return new Promise(() => {});
          },
        });
        const fiber = yield* verifyCallback({
          url: urlFor(443),
          subscriptionId: "sub_1",
          keys: [key],
        }).pipe(Effect.provideService(WebhookTransport, transport), Effect.flip, Effect.forkScoped);
        yield* Deferred.await(resolving);
        yield* TestClock.adjust("9999 millis");
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust("1 millis");
        assert.isDefined(fiber.pollUnsafe());
        assert.strictEqual((yield* Fiber.join(fiber)).reason, "timeout");
      }),
    ),
  );

  it.live("expiry cancels a pending DNS wait and discards its late result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        let connections = 0;
        receiver.server.on("connection", () => {
          connections += 1;
        });
        const resolving = yield* Deferred.make<void>();
        const answer = Promise.withResolvers<ReadonlyArray<{ address: string; family: number }>>();
        const transport = receiverTransport(receiver.ca, {
          resolve: () => {
            Deferred.doneUnsafe(resolving, Effect.void);
            return answer.promise;
          },
        });
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(1_000);
          const fiber = yield* transport
            .post({ url: urlFor(receiver.port), headers: {}, body: "{}", expiresAt: 2_000 })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(resolving);
          yield* TestClock.adjust("999 millis");
          assert.isUndefined(fiber.pollUnsafe());
          yield* TestClock.adjust("1 millis");
          assert.isDefined(fiber.pollUnsafe());
          assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "Failed", reason: "timeout" });
          answer.resolve([{ address: "127.0.0.1", family: 4 }]);
          yield* Effect.promise(() => answer.promise);
          yield* TestClock.adjust("10 seconds");
          assert.strictEqual(connections, 0);
          assert.strictEqual(receiver.received.length, 0);
        }).pipe(Effect.provide(TestClock.layer()));
      }),
    ),
  );

  it.live("does not connect when events are disabled during DNS", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        let enabled = true;
        const transport = receiverTransport(receiver.ca, {
          resolve: async () => {
            enabled = false;
            return [{ address: "127.0.0.1", family: 4 }];
          },
        });
        const input = {
          url: urlFor(receiver.port),
          headers: {},
          body: "{}",
          canDispatch: Effect.sync(() => enabled),
        };
        const exit = yield* Effect.exit(transport.post(input));
        assert.isTrue(Exit.hasInterrupts(exit));
        assert.strictEqual(receiver.received.length, 0);
      }),
    ),
  );

  it.live("does not start a connection when DNS completes at the subscription deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        const clock = yield* Clock.Clock;
        let now = 1_000;
        let connections = 0;
        receiver.server.on("connection", () => {
          connections += 1;
        });
        const transport = receiverTransport(receiver.ca, {
          resolve: async () => {
            now = 2_000;
            return [{ address: "127.0.0.1", family: 4 }];
          },
        });
        const input = { url: urlFor(receiver.port), headers: {}, body: "{}", expiresAt: 2_000 };
        const outcome = yield* transport.post(input).pipe(
          Effect.provideService(
            Clock.Clock,
            new Proxy(clock, {
              get: (target, property, receiver) =>
                property === "currentTimeMillisUnsafe"
                  ? () => now
                  : property === "currentTimeMillis"
                    ? Effect.sync(() => now)
                    : Reflect.get(target, property, receiver),
            }),
          ),
        );
        assert.deepStrictEqual(outcome, { _tag: "Failed", reason: "timeout" });
        assert.strictEqual(connections, 0);
        assert.strictEqual(receiver.received.length, 0);
      }),
    ),
  );

  it.live("signs the exact bytes it sends, verified by the standardwebhooks library", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        const body = `{"eventId":"t3e1_x","name":"t3.task_activity","data":{"é":"ü"},"cursor":"c1.abcdefgh.1"}`;
        const outcome = yield* postSigned({
          url: urlFor(receiver.port),
          subscriptionId: "sub_1",
          webhookId: "t3e1_x",
          keys: [key],
          body,
        }).pipe(Effect.provideService(WebhookTransport, receiverTransport(receiver.ca)));
        assert.strictEqual(outcome._tag, "Response");
        const [request] = receiver.received;
        assert.strictEqual(request!.body, body);
        assert.strictEqual(request!.headers["webhook-id"], "t3e1_x");
        assert.strictEqual(request!.headers["x-mcp-subscription-id"], "sub_1");
        assert.strictEqual(request!.headers["content-type"], "application/json");
        assert.strictEqual(request!.path, "/hooks/t3?token=abc");
        // Throws on a bad signature or a stale timestamp.
        new StandardWebhook(secret).verify(request!.body, request!.headers);
      }),
    ),
  );

  it.live("signs with both keys during a rotation, each verifiable alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        const next = testSecret(9);
        yield* postSigned({
          url: urlFor(receiver.port),
          subscriptionId: "sub_1",
          webhookId: "t3e1_y",
          keys: [decodeWebhookSecret(next)!, key],
          body: "{}",
        }).pipe(Effect.provideService(WebhookTransport, receiverTransport(receiver.ca)));
        const [request] = receiver.received;
        assert.strictEqual(request!.headers["webhook-signature"]!.split(" ").length, 2);
        new StandardWebhook(next).verify(request!.body, request!.headers);
        new StandardWebhook(secret).verify(request!.body, request!.headers);
        assert.throws(() =>
          new StandardWebhook(testSecret(3)).verify(request!.body, request!.headers),
        );
      }),
    ),
  );

  it("formats Standard Webhooks headers", () => {
    const headers = signedHeaders({
      webhookId: "msg_1",
      timestampSeconds: 1_700_000_000,
      subscriptionId: "sub_1",
      keys: [key],
      body: "{}",
    });
    assert.deepStrictEqual(Object.keys(headers).toSorted(), [
      "content-type",
      "webhook-id",
      "webhook-signature",
      "webhook-timestamp",
      "x-mcp-subscription-id",
    ]);
    assert.strictEqual(
      headers["webhook-signature"],
      webhookSignature([key], "msg_1", 1_700_000_000, "{}"),
    );
    assert.match(headers["webhook-signature"], /^v1,[A-Za-z0-9+/]+=*$/u);
  });

  it.live("verification sends a fresh challenge each time and needs it echoed exactly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        const transport = receiverTransport(receiver.ca);
        const verify = verifyCallback({
          url: urlFor(receiver.port),
          subscriptionId: "sub_1",
          keys: [key],
        }).pipe(Effect.provideService(WebhookTransport, transport));
        yield* verify;
        yield* verify;
        const challenges = receiver.received.map(
          (request) => (JSON.parse(request.body) as { challenge: string }).challenge,
        );
        assert.strictEqual(challenges.length, 2);
        assert.notStrictEqual(challenges[0], challenges[1]);
        assert.isTrue(
          receiver.received.every((request) =>
            request.headers["webhook-id"]!.startsWith("msg_verification_"),
          ),
        );
        new StandardWebhook(secret).verify(
          receiver.received[0]!.body,
          receiver.received[0]!.headers,
        );

        // Replaying an earlier challenge is not an echo of this one.
        receiver.respond.current = () => ({
          status: 200,
          body: JSON.stringify({ challenge: challenges[0] }),
        });
        const replayed = yield* Effect.flip(verify);
        assert.instanceOf(replayed, CallbackEndpointError);
        assert.strictEqual(replayed.reason, "challenge_failed");

        receiver.respond.current = () => ({ status: 500, body: "{}" });
        assert.strictEqual((yield* Effect.flip(verify)).reason, "http_500");
        receiver.respond.current = () => ({ status: 200, body: "not json" });
        assert.strictEqual((yield* Effect.flip(verify)).reason, "challenge_failed");
      }),
    ),
  );

  it.live("never follows a redirect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        receiver.respond.current = (request) =>
          request.path === "/elsewhere"
            ? { status: 200, body: "{}" }
            : { status: 302, headers: { location: "/elsewhere" } };
        const error = yield* Effect.flip(
          verifyCallback({
            url: urlFor(receiver.port, "/start"),
            subscriptionId: "sub_1",
            keys: [key],
          }).pipe(Effect.provideService(WebhookTransport, receiverTransport(receiver.ca))),
        );
        assert.strictEqual(error.reason, "redirect_refused");
        assert.deepStrictEqual(
          receiver.received.map((request) => request.path),
          ["/start"],
        );
      }),
    ),
  );

  it.live("checks the hostname on the certificate it connects to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver({ certificateFor: "other.test" });
        const outcome = yield* postSigned({
          url: urlFor(receiver.port),
          subscriptionId: "sub_1",
          webhookId: "t3e1_z",
          keys: [key],
          body: "{}",
        }).pipe(Effect.provideService(WebhookTransport, receiverTransport(receiver.ca)));
        assert.deepStrictEqual(outcome, { _tag: "Failed", reason: "tls_error" });
        assert.strictEqual(receiver.received.length, 0);
      }),
    ),
  );

  it.live("connects only to the addresses it checked (DNS rebinding)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        let lookups = 0;
        // First answer passes the check; any later lookup would point somewhere private.
        const transport = receiverTransport(receiver.ca, {
          resolve: async () => {
            lookups += 1;
            return [{ address: lookups === 1 ? "127.0.0.1" : "10.0.0.7", family: 4 }];
          },
        });
        const outcome = yield* postSigned({
          url: urlFor(receiver.port),
          subscriptionId: "sub_1",
          webhookId: "t3e1_r",
          keys: [key],
          body: "{}",
        }).pipe(Effect.provideService(WebhookTransport, transport));
        assert.strictEqual(outcome._tag, "Response");
        assert.strictEqual(lookups, 1);
        assert.strictEqual(outcome._tag === "Response" ? outcome.remoteAddress : "", "127.0.0.1");
        assert.strictEqual(receiver.received[0]!.remoteAddress, "127.0.0.1");
      }),
    ),
  );

  it.live("refuses a host when any answer is private, and IPv4 carried in IPv6", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        const post = (answers: ReadonlyArray<{ address: string; family: number }>) =>
          postSigned({
            url: urlFor(receiver.port),
            subscriptionId: "sub_1",
            webhookId: "t3e1_m",
            keys: [key],
            body: "{}",
          }).pipe(
            Effect.provideService(
              WebhookTransport,
              makeTransport({
                refuses: (address, family) =>
                  address === "127.0.0.1" ? false : isNonPublicAddress(address, family),
                resolve: async () => answers,
                ca: receiver.ca,
              }),
            ),
          );
        const refused = { _tag: "Failed", reason: "address_refused" } as const;
        assert.deepStrictEqual(
          yield* post([
            { address: "127.0.0.1", family: 4 },
            { address: "192.168.1.20", family: 4 },
          ]),
          refused,
        );
        assert.deepStrictEqual(yield* post([{ address: "::ffff:10.0.0.1", family: 6 }]), refused);
        assert.deepStrictEqual(yield* post([{ address: "::ffff:7f00:2", family: 6 }]), refused);
        assert.deepStrictEqual(
          yield* post([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]),
          refused,
        );
        assert.deepStrictEqual(yield* post([{ address: "fd00::1", family: 6 }]), refused);
        assert.deepStrictEqual(yield* post([]), refused);
        assert.strictEqual(receiver.received.length, 0);
      }),
    ),
  );

  it.live("production policy refuses loopback and private literals", () =>
    Effect.gen(function* () {
      const transport = makeTransport({ refuses: isNonPublicAddress });
      for (const host of [
        "127.0.0.1",
        "[::1]",
        "10.1.2.3",
        "169.254.169.254",
        "[::ffff:127.0.0.1]",
      ]) {
        const outcome = yield* transport.post({
          url: new URL(`https://${host}/hook`),
          headers: {},
          body: "{}",
        });
        assert.deepStrictEqual(outcome, { _tag: "Failed", reason: "address_refused" }, host);
      }
    }),
  );

  it.live("bounds a hanging socket by expiry or the normal callback timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* startReceiver();
        receiver.respond.current = () => "hang";
        for (const expiresAt of [2_000, undefined]) {
          const closed = yield* Deferred.make<void>();
          receiver.server.once("secureConnection", (socket) => {
            socket.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
          });
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(1_000);
            const fiber = yield* postSigned({
              url: urlFor(receiver.port),
              subscriptionId: "sub_1",
              webhookId: "t3e1_t",
              keys: [key],
              body: "{}",
              ...(expiresAt === undefined ? {} : { expiresAt }),
            }).pipe(
              Effect.provideService(WebhookTransport, receiverTransport(receiver.ca)),
              Effect.forkScoped,
            );
            yield* Queue.take(receiver.requests);
            const duration = expiresAt === undefined ? 10_000 : expiresAt - 1_000;
            yield* TestClock.adjust(duration - 1);
            assert.isUndefined(fiber.pollUnsafe());
            yield* TestClock.adjust(1);
            assert.isDefined(fiber.pollUnsafe());
            assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "Failed", reason: "timeout" });
            yield* Deferred.await(closed);
          }).pipe(Effect.provide(TestClock.layer()));
        }
      }),
    ),
  );

  it("accepts only https callback URLs without credentials or fragments, and redacts queries", () => {
    assert.isDefined(parseCallbackUrl("https://hooks.example.com/t3"));
    for (const bad of [
      "http://hooks.example.com/t3",
      "https://user:pass@hooks.example.com/t3",
      "https://hooks.example.com/t3#x",
      "ftp://hooks.example.com",
      "not a url",
      42,
      `https://hooks.example.com/${"a".repeat(2100)}`,
    ])
      assert.isUndefined(parseCallbackUrl(bad), String(bad).slice(0, 40));
    assert.strictEqual(
      redactCallbackUrl("https://hooks.example.com/t3?token=secret"),
      "https://hooks.example.com/t3?…",
    );
  });

  it("validates Standard Webhooks secrets and compares in constant time", () => {
    assert.isDefined(decodeWebhookSecret(testSecret()));
    assert.isUndefined(decodeWebhookSecret(`whsec_${Buffer.alloc(16).toString("base64")}`));
    assert.isUndefined(decodeWebhookSecret(`whsec_${Buffer.alloc(65).toString("base64")}`));
    assert.isUndefined(decodeWebhookSecret(Buffer.alloc(32).toString("base64")));
    assert.isUndefined(decodeWebhookSecret("whsec_***"));
    assert.isTrue(constantTimeEqual("abc", "abc"));
    assert.isFalse(constantTimeEqual("abc", "abd"));
    assert.isFalse(constantTimeEqual("abc", "abcd"));
  });
});
