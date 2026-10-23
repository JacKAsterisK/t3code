import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

vi.mock("@t3tools/shared/distribution", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/distribution")>()),
  nativeUpdatesEnabled: false,
  cloudEnabled: false,
  distributionUpdateGuidance:
    "Updates come from JacKAsterisK/t3code. Use Reprint Hub to verify, stage and activate them while T3 Code is stopped.",
}));

import { requestGuarded, RpcPermissionGuard, runStreamGuarded } from "./client.ts";
import { updateOutdatedHost } from "../connection/outdatedHostUpdate.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type { RpcSession } from "./session.ts";

it.effect("disabled native updater never dispatches unary, progress or desktop commit RPCs", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const client = new Proxy(
      {},
      {
        get: (_target, method) => () =>
          Effect.sync(() => {
            calls.push(String(method));
            return {};
          }),
      },
    ) as WsRpcProtocolClient;
    const activeSession = yield* SubscriptionRef.make(
      Option.some<RpcSession>({
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      }),
    );
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("fixture"),
        label: "fixture",
        httpBaseUrl: "http://localhost",
        wsBaseUrl: "ws://localhost",
      }),
      state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
      session: activeSession,
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    yield* Effect.gen(function* () {
      const updateError = yield* Effect.flip(
        requestGuarded(WS_METHODS.serverUpdateServer, { targetVersion: "9.9.9" }),
      );
      expect(updateError._tag).toBe("EnvironmentRpcUnavailableError");
      expect(updateError.message).toContain("JacKAsterisK/t3code");
      expect(updateError.message).toContain("Hub");
      expect(
        (yield* Effect.flip(
          requestGuarded(WS_METHODS.serverCommitDesktopUpdate, { requestId: "fixture" }),
        ))._tag,
      ).toBe("EnvironmentRpcUnavailableError");
      expect(
        (yield* Effect.flip(
          runStreamGuarded(WS_METHODS.serverUpdateServerWithProgress, {
            targetVersion: "9.9.9",
          }).pipe(Stream.runDrain),
        ))._tag,
      ).toBe("EnvironmentRpcUnavailableError");
      expect(calls).toEqual([]);
      expect(
        (yield* Effect.flip(
          runStreamGuarded(WS_METHODS.cloudInstallRelayClient, {}).pipe(Stream.runDrain),
        ))._tag,
      ).toBe("EnvironmentRpcUnavailableError");
      expect(calls).toEqual([]);
      yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
        threadId: ThreadId.make("fixture"),
      });
      expect(calls).toEqual([ORCHESTRATION_V2_WS_METHODS.getThreadProjection]);
    }).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
    );
  }),
);

it.effect(
  "disabled updater refuses the old-protocol socket path before acquiring network dependencies",
  () =>
    Effect.gen(function* () {
      const result = yield* updateOutdatedHost(
        EnvironmentId.make("fixture"),
        { targetVersion: "9.9.9" },
        () => Effect.void,
      ).pipe(
        Effect.flip,
        Effect.provide(
          Context.empty() as Context.Context<
            Effect.Services<ReturnType<typeof updateOutdatedHost>>
          >,
        ),
        Effect.scoped,
      );
      expect(result._tag).toBe("OutdatedHostUpdateError");
      expect(result.message).toContain("JacKAsterisK/t3code");
    }),
);
