import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type HostPowerSnapshot,
  type ClientActivityReportInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const TEST_NOW = DateTime.makeUnsafe("2026-05-13T00:00:00.000Z");

const nominalHostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: TEST_NOW,
};

function makeReport(overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput {
  return {
    clientId: "client-1",
    clientKind: "web",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "vcs-status", cwd: "/repo" }],
    ttlMs: 45_000,
    observedAt: TEST_NOW,
    ...overrides,
  };
}

function layerFor(
  hostPower: HostPowerSnapshot,
  settingsOverrides: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  const layerHost = Layer.effect(
    HostPowerMonitor.HostPowerMonitor,
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);
      let snapshot = hostPower;
      return HostPowerMonitor.HostPowerMonitor.of({
        snapshot: Effect.sync(() => snapshot),
        report: (next) =>
          Effect.sync(() => {
            snapshot = next;
          }).pipe(Effect.andThen(PubSub.publish(changes, next)), Effect.asVoid),
        streamChanges: Stream.fromPubSub(changes),
      });
    }),
  );
  return BackgroundPolicy.layer.pipe(
    Layer.provide(Layer.merge(layerHost, ServerSettings.layerTest(settingsOverrides))),
  );
}

describe("BackgroundPolicy", () => {
  it.effect("freezes every connected prompt before acknowledging an idle update", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const native = policy.nativeUpdate!;
      const session = AuthSessionId.make("draft-session");
      const client = RpcClientId.make(42);
      const activity = (preparedReservationId: string | null) =>
        makeReport({
          nativeUpdate: { protocolVersion: 1, hasUnsentPrompt: false, preparedReservationId },
        });
      yield* native.registerClient(session, client);
      yield* policy.reportClientActivity(session, client, activity(null));
      const subscribed = yield* policy.subscribe;
      const preparing = yield* native.freeze("update-reservation").pipe(Effect.forkScoped);
      yield* subscribed.changes.pipe(
        Stream.filter((state) => state.nativeUpdate?.reservationId === "update-reservation"),
        Stream.runHead,
      );
      assert.equal(yield* native.verify("update-reservation"), false);
      yield* policy.reportClientActivity(session, client, activity("update-reservation"));
      assert.equal(yield* Fiber.join(preparing), true);
      assert.equal(yield* native.verify("update-reservation"), true);
      const legacy = RpcClientId.make(43);
      yield* native.registerClient(session, legacy);
      assert.equal(yield* native.verify("update-reservation"), false);
      yield* policy.removeRpcClient(session, legacy);
      assert.equal(yield* native.verify("update-reservation"), true);
      yield* native.thaw("update-reservation");
      assert.equal((yield* policy.snapshot).nativeUpdate?.reservationId, null);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("declines freeze when a client reports an unsent prompt", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("draft"),
        RpcClientId.make(9),
        makeReport({
          nativeUpdate: { protocolVersion: 1, hasUnsentPrompt: true, preparedReservationId: null },
        }),
      );
      assert.equal(yield* policy.nativeUpdate!.freeze("update-reservation"), false);
      yield* policy.nativeUpdate!.thaw("update-reservation");
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("removes all leases for a disconnected websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );
      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1));

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, []);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps leases from another session when rpc client ids are reused", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientId = RpcClientId.make(1);
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        rpcClientId,
        makeReport({ clientId: "client-1" }),
      );
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        rpcClientId,
        makeReport({ clientId: "client-2" }),
      );

      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), rpcClientId);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.leases[0]?.sessionId, AuthSessionId.make("session-2"));
      assert.equal(snapshot.leases[0]?.clientId, "client-2");
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("bounds client-id churn for one websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("session-1");
      const rpcClientId = RpcClientId.make(1);
      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          rpcClientId,
          makeReport({ clientId: `client-${index}` }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
      assert.isTrue(
        snapshot.leases.some(
          (lease) =>
            lease.clientId ===
            `client-${BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT}`,
        ),
      );
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("host suspension disables scoped and opportunistic work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor({
          ...nominalHostPower,
          suspended: true,
          stale: false,
        }),
      ),
    ),
  );

  it.effect("keeps background demand visible while preventing scoped work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, visible: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps scoped work active after a recently used visible window loses focus", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: true }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("battery saver profile pauses scoped work on battery", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            onBattery: "true",
            stale: false,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );

  it.effect("does not gate work on stale host power values", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            locked: "true",
            onBattery: "true",
            lowPowerMode: "true",
            thermalState: "critical",
            stale: true,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );
});
