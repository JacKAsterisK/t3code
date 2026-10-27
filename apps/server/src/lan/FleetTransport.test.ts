import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, LanFleetError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FLEET_ROSTER_ENV } from "./FleetBootstrap.ts";
import * as Config from "../config.ts";
import * as FleetTransport from "./FleetTransport.ts";
import * as FleetNetwork from "./FleetNetwork.ts";
import * as FleetVault from "./FleetVault.ts";
import { generateFleetIdentity, type FleetVaultRecord } from "./FleetAuthority.ts";

const fixture = Effect.fn("FleetTransportTest.fixture")(function* (
  initial?: FleetVaultRecord,
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    conflict?: boolean;
    vaultUnavailable?: boolean;
    addresses?: readonly string[];
    beforeListen?: Effect.Effect<void>;
    events?: string[];
    ipv6Unavailable?: boolean;
  } = {},
) {
  const config = yield* Config.ServerConfig;
  let record: FleetVaultRecord | undefined = initial;
  let starts = 0;
  let closes = 0;
  let saves = 0;
  let conflict = options.conflict ?? false;
  let vaultUnavailable = options.vaultUnavailable ?? false;
  let reads = 0;
  const listenAddresses: string[] = [];
  const services = yield* Layer.build(
    FleetTransport.layerServices.pipe(
      Layer.provide(
        Layer.succeed(
          HostProcess.Environment,
          options.environment ?? {
            [FLEET_ROSTER_ENV]: process.cwd() + "/synthetic-roster.json",
          },
        ),
      ),
      Layer.provide(
        Layer.succeed(FleetVault.FleetVault, {
          read: Effect.suspend(() => {
            reads++;
            return vaultUnavailable
              ? Effect.fail(new LanFleetError({ reason: "unavailable" }))
              : Effect.succeed(record);
          }),
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
          addresses: Effect.succeed(options.addresses ?? ["192.168.40.10", "192.168.50.10"]),
          listen: (input) =>
            Effect.gen(function* () {
              listenAddresses.push(input.listen.address);
              yield* options.beforeListen ?? Effect.void;
              if (options.ipv6Unavailable && input.listen.address === "::")
                return yield* new LanFleetError({ reason: "transport" });
              if (conflict) return yield* new LanFleetError({ reason: "transport" });
              starts++;
              options.events?.push("start");
              return {
                httpBaseUrl: `https://${input.listen.address}:${input.listen.port}/`,
                wsBaseUrl: "wss://synthetic-only/",
                close: () => {
                  closes++;
                  options.events?.push("close");
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
    listenAddresses,
    stats: () => ({ record, starts, closes, saves, reads }),
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
  it.effect("listens on IPv6 and IPv4 while retaining the saved endpoint identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const tls = yield* f.transport.prepare(f.origin);
      const record = { ...f.identity, tls };
      yield* f.transport.persist(record);
      expect(f.listenAddresses).toEqual(["::"]);
      expect(f.stats().record?.tls).toEqual(tls);
      expect(yield* f.transport.ready(record)).toBe(true);
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect("retains IPv4 access when the system cannot open a dual-stack listener", () =>
    Effect.gen(function* () {
      const f = yield* fixture(undefined, { ipv6Unavailable: true });
      const tls = yield* f.transport.prepare(f.origin);
      const record = { ...f.identity, tls };
      yield* f.transport.persist(record);
      expect(f.listenAddresses).toEqual(["::", "192.168.40.10"]);
      expect(yield* f.transport.ready(record)).toBe(true);
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect("restores an enabled saved listener at startup without rewriting keys or access", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const tls = yield* first.transport.prepare(first.origin);
      const record = { ...first.identity, tls, tlsEnabled: true };
      const restarted = yield* fixture(record);
      expect(yield* restarted.transport.ready(record)).toBe(true);
      yield* restarted.transport.suggestions;
      expect(restarted.stats()).toMatchObject({ starts: 1, saves: 0, record });
      yield* Effect.all(
        [restarted.transport.persist(record), restarted.transport.persist(record)],
        {
          concurrency: "unbounded",
        },
      );
      expect(yield* restarted.transport.ready(record)).toBe(true);
      expect(restarted.stats()).toMatchObject({ starts: 1, saves: 2, record });
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect("keeps a stopped or unconfigured endpoint stopped across restarts", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const tls = yield* first.transport.prepare(first.origin);
      for (const record of [first.identity, { ...first.identity, tls, tlsEnabled: false }]) {
        const restarted = yield* fixture(record);
        expect(yield* restarted.transport.ready(record)).toBe(false);
        expect(restarted.stats()).toMatchObject({ starts: 0, saves: 0, record });
      }
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "does not restore or read saved secrets when launch configuration is absent, empty or invalid",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture();
        const tls = yield* first.transport.prepare(first.origin);
        const record = { ...first.identity, tls, tlsEnabled: true };
        for (const environment of [
          {},
          ...["", " ", "relative.json"].map((value) => ({ [FLEET_ROSTER_ENV]: value })),
        ]) {
          const restarted = yield* fixture(record, { environment });
          expect(yield* restarted.transport.ready(record)).toBe(false);
          expect(restarted.stats()).toMatchObject({ starts: 0, saves: 0, reads: 0, record });
        }
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect("keeps local startup available on restore failure without changing saved trust", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const tls = yield* first.transport.prepare(first.origin);
      const record = { ...first.identity, tls, tlsEnabled: true };
      for (const options of [{ conflict: true }, { vaultUnavailable: true }, { addresses: [] }]) {
        const restarted = yield* fixture(record, options);
        expect(yield* restarted.transport.ready(record)).toBe(false);
        expect(restarted.stats()).toMatchObject({ starts: 0, saves: 0, record });
      }
      const substituted = { ...record, tls: { ...tls, publicKeySha256: "0".repeat(64) } };
      const rejected = yield* fixture(substituted);
      expect(yield* rejected.transport.ready(substituted)).toBe(false);
      expect(rejected.stats()).toMatchObject({ starts: 0, saves: 0, record: substituted });
      const recovered = yield* fixture(record);
      expect(yield* recovered.transport.ready(record)).toBe(true);
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect("cleans up a listener acquired while startup is interrupted", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const tls = yield* first.transport.prepare(first.origin);
      const record = { ...first.identity, tls, tlsEnabled: true };
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const events: string[] = [];
      const startup = yield* Effect.scoped(
        fixture(record, {
          events,
          beforeListen: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(proceed)),
          ),
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const interrupted = yield* Fiber.interrupt(startup).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(interrupted);
      expect(events).toEqual(["start", "close"]);
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect("closes a restored listener with its server scope", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const tls = yield* first.transport.prepare(first.origin);
      const record = { ...first.identity, tls, tlsEnabled: true };
      const restarted = yield* Effect.scoped(fixture(record));
      expect(restarted.stats()).toMatchObject({ starts: 1, closes: 1, saves: 0 });
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
