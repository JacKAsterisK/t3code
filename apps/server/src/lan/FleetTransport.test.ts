import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, LanFleetError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Config from "../config.ts";
import * as FleetTransport from "./FleetTransport.ts";
import * as FleetNetwork from "./FleetNetwork.ts";
import * as FleetVault from "./FleetVault.ts";
import { generateFleetIdentity, type FleetVaultRecord } from "./FleetAuthority.ts";

const fixture = Effect.fn("FleetTransportTest.fixture")(function* (initial?: FleetVaultRecord) {
  const config = yield* Config.ServerConfig;
  let record: FleetVaultRecord | undefined = initial;
  let starts = 0;
  let closes = 0;
  let saves = 0;
  let conflict = false;
  let vaultUnavailable = false;
  const services = yield* Layer.build(
    FleetTransport.layerServices.pipe(
      Layer.provide(
        Layer.succeed(FleetVault.FleetVault, {
          read: Effect.sync(() => record),
          save: (next) =>
            vaultUnavailable
              ? Effect.fail(new LanFleetError({ reason: "unavailable" }))
              : Effect.sync(() => {
                  record = next;
                  saves++;
                }),
        }),
      ),
      Layer.provide(
        Layer.succeed(FleetNetwork.FleetNetwork, {
          addresses: Effect.succeed(["192.168.40.10", "192.168.50.10"]),
          listen: (input) =>
            conflict
              ? Effect.fail(new LanFleetError({ reason: "transport" }))
              : Effect.sync(() => {
                  starts++;
                  return {
                    httpBaseUrl: `https://${input.listen.address}:${input.listen.port}/`,
                    wsBaseUrl: "wss://synthetic-only/",
                    close: () => {
                      closes++;
                      return Promise.resolve();
                    },
                  };
                }),
        }),
      ),
    ),
  );
  const transport = Context.get(services, FleetTransport.FleetTransport);
  const identity = generateFleetIdentity(
    EnvironmentId.make("environment-synthetic"),
    "synthetic-fleet",
    "",
    true,
    { autoPickup: true, access: "read-only" },
  );
  const port = config.port >= 1024 && config.port < 65535 ? config.port + 1 : 4433;
  return {
    transport,
    identity,
    origin: `https://192.168.40.10:${port}`,
    stats: () => ({ record, starts, closes, saves }),
    conflict: (value: boolean) => {
      conflict = value;
    },
    vaultUnavailable: (value: boolean) => {
      vaultUnavailable = value;
    },
  };
});
const configLayer = Config.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fleet-transport-synthetic-",
});

it.layer(NodeServices.layer)("confirmed fleet transport", (it) => {
  it.effect("does not resume a persisted listener during construction or passive inspection", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const tls = yield* first.transport.prepare(first.origin);
      const record = { ...first.identity, tls, tlsEnabled: true };
      const restarted = yield* fixture(record);
      expect(yield* restarted.transport.ready(record)).toBe(false);
      yield* restarted.transport.suggestions;
      expect(restarted.stats()).toMatchObject({ starts: 0, saves: 0 });
      yield* restarted.transport.persist(record);
      expect(yield* restarted.transport.ready(record)).toBe(true);
      expect(restarted.stats()).toMatchObject({ starts: 1, saves: 1 });
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "suggests only supplied local interfaces and reuses one endpoint without rotating its key",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect((yield* f.transport.suggestions).length).toBe(2);
        expect(f.stats()).toMatchObject({ starts: 0, saves: 0 });
        const tls = yield* f.transport.prepare(f.origin);
        expect(yield* f.transport.prepare(f.origin, tls)).toEqual(tls);
        const record = { ...f.identity, tls };
        expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThan(2400);
        yield* f.transport.persist(record);
        yield* Effect.all([f.transport.persist(record), f.transport.persist(record)], {
          concurrency: "unbounded",
        });
        yield* f.transport.persist({ ...record, enabled: false });
        expect(f.stats()).toMatchObject({ starts: 1, closes: 0 });
        expect(f.stats().record?.tls?.privateKey).toBe(tls.privateKey);
        yield* f.transport.persist({ ...record, tlsEnabled: false });
        expect(f.stats().closes).toBe(1);
        yield* f.transport.persist({ ...record, tlsEnabled: true });
        expect(f.stats().starts).toBe(2);
        expect(f.stats().record?.tls?.privateKey).toBe(tls.privateKey);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "does not persist an unusable port or leave a listener after a failed vault write",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const tls = yield* f.transport.prepare(f.origin);
        const record = { ...f.identity, tls };
        f.conflict(true);
        expect(yield* f.transport.persist(record).pipe(Effect.flip)).toMatchObject({
          reason: "transport",
        });
        expect(f.stats()).toMatchObject({ starts: 0, saves: 0, record: undefined });
        f.conflict(false);
        f.vaultUnavailable(true);
        expect(yield* f.transport.persist(record).pipe(Effect.flip)).toMatchObject({
          reason: "unavailable",
        });
        expect(f.stats()).toMatchObject({ starts: 1, closes: 1, saves: 0, record: undefined });
        f.vaultUnavailable(false);
        yield* f.transport.persist(record);
        expect(f.stats()).toMatchObject({ starts: 2, closes: 1, saves: 1 });
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("refuses guessed addresses, insecure endpoints and silent endpoint replacement", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const origin of [
        "http://192.168.40.10:4443",
        "https://192.168.40.99:4443",
        "https://0.0.0.0:4443",
        "https://synthetic.example.test:4443",
      ])
        expect(yield* f.transport.prepare(origin).pipe(Effect.flip)).toMatchObject({
          reason: "configuration",
        });
      const tls = yield* f.transport.prepare(f.origin);
      expect(
        yield* f.transport.prepare("https://192.168.50.10:4443", tls).pipe(Effect.flip),
      ).toMatchObject({ reason: "configuration" });
      expect(f.stats()).toMatchObject({ starts: 0, saves: 0 });
    }).pipe(Effect.provide(configLayer)),
  );
});
