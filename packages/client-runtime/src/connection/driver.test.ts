import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcSession from "../rpc/session.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );

  it.effect("probes a pinned fleet route through the desktop gateway", () =>
    Effect.gen(function* () {
      const target = new BearerConnectionTarget({
        environmentId: ENTRY.target.environmentId,
        label: ENTRY.target.label,
        connectionId: "fleet-route",
      });
      const origin = "https://fleet.example.test";
      const fleetTls = { origin, certificate: "synthetic-pin", publicKeySha256: "a".repeat(64) };
      const route = {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: target.connectionId,
            environmentId: target.environmentId,
            label: target.label,
            httpBaseUrl: origin,
            wsBaseUrl: "wss://fleet.example.test",
            fleetTls,
          }),
        ),
      };
      const gatewayUrl = "http://127.0.0.1:41001/";
      const requested: string[] = [];
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: () =>
                Effect.succeed({
                  environmentId: target.environmentId,
                  label: target.label,
                  httpBaseUrl: gatewayUrl,
                  socketUrl: "ws://127.0.0.1:41001/ws",
                  httpAuthorization: null,
                  target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({}),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
              rememberCheckedDescriptor: () => Effect.void,
            }),
            Layer.succeed(ClientCapabilities.FleetTlsGateway, {
              prepare: (input) =>
                Effect.sync(() => {
                  expect(input).toEqual({
                    environmentId: target.environmentId,
                    identity: fleetTls,
                    savedRoute: true,
                  });
                  return { httpBaseUrl: gatewayUrl, wsBaseUrl: "ws://127.0.0.1:41001/" };
                }),
            }),
            FetchHttpClient.layer.pipe(
              Layer.provide(
                Layer.succeed(FetchHttpClient.Fetch, (input) => {
                  requested.push(String(input));
                  return Promise.resolve(
                    Response.json({
                      environmentId: target.environmentId,
                      label: target.label,
                      platform: { os: "windows", arch: "x64" },
                      serverVersion: "0.0.0-test",
                      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                      capabilities: { repositoryIdentity: true },
                    }),
                  );
                }),
              ),
            ),
          ),
        ),
      );
      expect(yield* driver.preflight({ ...route, enabled: true }, route)).toBe("ready");
      expect(requested).toEqual([gatewayUrl + ".well-known/t3/environment"]);
    }),
  );
});
