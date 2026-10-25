import { LanFleetError } from "@t3tools/contracts";
import {
  createFleetTlsCertificate,
  verifyFleetTlsCertificate,
} from "@t3tools/shared/fleetTlsCertificate";
import type { FleetProxy } from "@t3tools/shared/fleetTlsProxy";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as Vault from "./FleetVault.ts";
import * as Network from "./FleetNetwork.ts";
import type { FleetVaultRecord } from "./FleetAuthority.ts";
import { resolveFleetBootstrap } from "./FleetBootstrap.ts";

type StoredTls = NonNullable<FleetVaultRecord["tls"]>;
export class FleetTransport extends Context.Service<
  FleetTransport,
  {
    readonly suggestions: Effect.Effect<readonly string[]>;
    readonly prepare: (
      origin: string,
      previous?: StoredTls,
    ) => Effect.Effect<StoredTls, LanFleetError>;
    readonly ready: (record: FleetVaultRecord) => Effect.Effect<boolean>;
    readonly persist: (record: FleetVaultRecord) => Effect.Effect<void, LanFleetError>;
  }
>()("t3/lan/FleetTransport") {}

const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const processEnvironment = yield* HostProcess.Environment;
  const vault = yield* Vault.FleetVault;
  const network = yield* Network.FleetNetwork;
  const mutex = yield* Semaphore.make(1);
  let running: { origin: string; proxy: FleetProxy } | undefined;
  const suggestions = network.addresses.pipe(
    Effect.map((addresses) =>
      addresses.map(
        (address) =>
          `https://${address}:${config.port >= 1024 && config.port < 65535 ? config.port + 1 : 4433}`,
      ),
    ),
  );
  const prepare = Effect.fn("FleetTransport.prepare")(function* (
    origin: string,
    previous?: StoredTls,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const addresses = yield* network.addresses;
    return yield* Effect.try({
      try: () => {
        const url = new URL(origin);
        const port = Number(url.port || 443);
        if (
          url.protocol !== "https:" ||
          url.origin !== origin ||
          port < 1024 ||
          port > 65535 ||
          port === config.port ||
          !addresses.includes(url.hostname)
        )
          throw new Error(
            "Choose an actual local LAN address and a separate unprivileged TLS port.",
          );
        if (previous !== undefined) {
          if (
            previous.origin !== origin ||
            !verifyFleetTlsCertificate(
              previous.certificate,
              url.hostname,
              previous.publicKeySha256,
              now,
            )
          )
            throw new Error("Existing fleet endpoint requires explicit review.");
          return previous;
        }
        return { origin, ...createFleetTlsCertificate({ address: url.hostname, now }) };
      },
      catch: () => new LanFleetError({ reason: "configuration" }),
    });
  });
  const ensure = Effect.fn("FleetTransport.ensure")(function* (record: FleetVaultRecord) {
    if (record.tls === undefined) return;
    if (record.tlsEnabled === false) {
      if (running !== undefined) {
        yield* Effect.promise(() => running!.proxy.close());
        running = undefined;
      }
      return;
    }
    if (running !== undefined) {
      if (running.origin !== record.tls.origin)
        return yield* new LanFleetError({ reason: "configuration" });
      return;
    }
    const identity = yield* prepare(record.tls.origin, record.tls);
    const url = new URL(identity.origin);
    const proxy = yield* network.listen({
      listen: { address: url.hostname, port: Number(url.port || 443) },
      target: `http://${config.host === "::1" ? "[::1]" : config.host === undefined || ["0.0.0.0", "::", "localhost"].includes(config.host) ? "127.0.0.1" : config.host}:${config.port}/`,
      serverTls: identity,
    });
    running = { origin: identity.origin, proxy };
  });
  const persist = Effect.fn("FleetTransport.persist")(
    function* (record: FleetVaultRecord) {
      const previous = running;
      // A port conflict must not commit a new, unusable endpoint identity. If
      // vault persistence fails, close only the listener acquired by this attempt.
      yield* ensure(record);
      yield* vault.save(record).pipe(
        Effect.tapError(() => {
          if (previous !== undefined || running === undefined) return Effect.void;
          const acquired = running;
          running = undefined;
          return Effect.promise(() => acquired.proxy.close());
        }),
      );
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );
  yield* Effect.addFinalizer(() =>
    running === undefined ? Effect.void : Effect.promise(() => running!.proxy.close()),
  );
  // The saved setting is the one-time startup consent. Restore the listener
  // once per server lifetime, without rewriting keys, grants or vault settings.
  // An explicitly disabled/missing launch configuration still takes precedence.
  yield* Effect.gen(function* () {
    const bootstrap = yield* Effect.try({
      try: () => resolveFleetBootstrap(processEnvironment),
      catch: () => new LanFleetError({ reason: "configuration" }),
    });
    if (bootstrap === undefined) return;
    const record = yield* vault.read;
    if (record?.tls === undefined || record.tlsEnabled === false) return;
    yield* ensure(record);
  }).pipe(
    Effect.uninterruptible,
    mutex.withPermit,
    Effect.catchTags({
      LanFleetError: () =>
        Effect.logWarning(
          "Saved encrypted LAN access could not start. Check the selected local address, port and OS-stored key in Connections; saved keys and access were preserved.",
        ),
    }),
  );
  return FleetTransport.of({
    suggestions,
    prepare,
    persist,
    ready: (record) =>
      Effect.sync(
        () =>
          record.tls !== undefined &&
          record.tlsEnabled !== false &&
          running?.origin === record.tls.origin,
      ),
  });
});
export const layerServices = Layer.effect(FleetTransport, make);
export const layer = layerServices.pipe(Layer.provide(Vault.layer), Layer.provide(Network.layer));
