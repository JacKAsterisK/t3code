import {
  AGENT_EVENT_LIMITS,
  AGENT_EVENT_PAYLOAD_SCHEMA,
  type AgentEventEnvelope,
  type AgentEventProbeDetail,
  formatAgentEventCursor,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as AgentEventStore from "../agentEvents/AgentEventStore.ts";
import * as FactRetention from "../agentEvents/AgentFactRetention.ts";
import * as FactDeriver from "../agentEvents/AgentFactDeriver.ts";
import * as FleetUsers from "../lan/FleetUsers.ts";
import * as Gateway from "../lan/GatewayCompatibility.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SourceStore from "../persistence/OrchestrationEventStore.ts";
import { canonicalJson, eventIdFor, randomToken } from "../agentEvents/identity.ts";
import { redactCallbackUrl } from "../agentEvents/WebhookSender.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * T3 Code LAN: `t3 agent-events`, the operator's side of MCP Events. It shares the database with a
 * running server (WAL and a busy timeout), so a probe written here is sent by that server's
 * delivery worker within a second. It never reads or prints a secret.
 */

export class AgentEventsCliError extends Schema.TaggedError<AgentEventsCliError>()(
  "AgentEventsCliError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const runWithDatabase = Effect.fn("agentEvents.runWithDatabase")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, E, R>,
  quiet: boolean,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: quiet });
  return yield* run.pipe(
    Effect.provide(
      Layer.mergeAll(
        SqlitePersistence.layerConfig,
        ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer)),
      ).pipe(
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, quiet ? "Error" : config.logLevel)),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The probe event: a replayable `probe` fact for one subscription. The same nonce twice is the
 * same event (one event id), so retrying the command never sends a second one.
 */
export const makeProbe = (input: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly subscriptionId: string;
  readonly nonce: string;
  readonly note: string | null;
  readonly occurredAt: number;
}) => {
  const factKey = `probe:${input.environmentId}:${input.subscriptionId}:${input.nonce}`;
  const detail: AgentEventProbeDetail = {
    nonce: input.nonce,
    note: input.note,
    subscriptionId: input.subscriptionId,
  };
  const data: AgentEventEnvelope = {
    schema: AGENT_EVENT_PAYLOAD_SCHEMA,
    kind: "probe",
    factKey,
    summary:
      `T3 Code test event ${input.nonce}: an operator on ${input.environmentLabel} is checking that T3 events reach you. Tell the user you received it and quote the nonce.`.slice(
        0,
        280,
      ),
    textIsUntrusted: true,
    environment: { id: input.environmentId, label: input.environmentLabel },
    thread: null,
    run: null,
    owner: null,
    origin: {
      environmentId: input.environmentId,
      threadSequence: null,
      occurredAt: iso(input.occurredAt),
    },
    relay: null,
    detail: { ...detail },
  };
  return { eventId: eventIdFor("probe", factKey, "1"), factKey, dataJson: canonicalJson(data) };
};

const probeCommand = Command.make("probe", {
  ...authLocationFlags,
  subscription: Flag.String("subscription").pipe(
    Flag.withDescription("The subscription id (sub_…) to send the probe to; see `status`."),
  ),
  nonce: Flag.String("nonce").pipe(
    Flag.withDescription("Text the agent should quote back. Random when omitted."),
    Flag.optional,
  ),
  note: Flag.String("note").pipe(
    Flag.withDescription("An optional note carried in the probe."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a test event to one agent-event subscription, to check that the agent wakes on it.",
  ),
  Command.withHandler((flags) =>
    runWithDatabase(
      flags,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const subscription = yield* AgentEventStore.findSubscription(flags.subscription);
        if (subscription === undefined)
          return yield* new AgentEventsCliError({
            detail: `No subscription ${flags.subscription}. Run \`t3 agent-events status\`.`,
          });
        if (subscription.state !== "active" || subscription.expiresAt <= now)
          return yield* new AgentEventsCliError({
            detail: `Subscription ${flags.subscription} is ${subscription.expiresAt <= now ? "expired" : subscription.state}; the agent must subscribe again first.`,
          });
        const nonce = Option.getOrElse(flags.nonce, () => randomToken(6));
        const note = Option.getOrNull(flags.note);
        if (
          nonce.length === 0 ||
          nonce.length > AGENT_EVENT_LIMITS.probeNonceLength ||
          (note?.length ?? 0) > AGENT_EVENT_LIMITS.probeNoteLength
        )
          return yield* new AgentEventsCliError({
            detail: `The nonce must be 1-${AGENT_EVENT_LIMITS.probeNonceLength} characters and the note at most ${AGENT_EVENT_LIMITS.probeNoteLength}.`,
          });
        const environment = yield* ServerEnvironment.ServerEnvironment;
        const descriptor = yield* environment.getDescriptor;
        const probe = makeProbe({
          environmentId: descriptor.environmentId,
          environmentLabel: descriptor.label,
          subscriptionId: subscription.subscriptionId,
          nonce,
          note,
          occurredAt: now,
        });
        const appended = yield* AgentEventStore.appendProbe({
          eventId: probe.eventId,
          subscriptionId: subscription.subscriptionId,
          occurredAt: now,
          dataJson: probe.dataJson,
          now,
        });
        const { epoch } = yield* AgentEventStore.logState();
        const result = {
          subscriptionId: subscription.subscriptionId,
          eventId: probe.eventId,
          nonce,
          sequence: appended.logSeq,
          cursor: formatAgentEventCursor(epoch, appended.logSeq),
          queuedAt: iso(now),
          alreadyQueued: !appended.created,
        };
        yield* Console.log(
          flags.json
            ? encodeJson(result)
            : [
                `${appended.created ? "Queued" : "Already queued"} probe ${probe.eventId} (nonce ${nonce}) for ${subscription.subscriptionId}.`,
                "The running server sends it within a second while agent events are on. Watch it with `t3 agent-events status`.",
              ].join("\n"),
        );
      }),
      flags.json,
    ),
  ),
);

const statusCommand = Command.make("status", {
  ...authLocationFlags,
  json: jsonFlag,
  deliveries: Flag.Int("deliveries").pipe(
    Flag.withDescription("Recent deliveries to list per subscription."),
    Flag.withDefault(10),
  ),
}).pipe(
  Command.withDescription(
    "List agent-event subscriptions and their recent deliveries, attempts and last status (no secrets).",
  ),
  Command.withHandler((flags) =>
    runWithDatabase(
      flags,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const log = yield* AgentEventStore.logState();
        const retention = yield* FactRetention.status();
        const subscriptions = yield* AgentEventStore.listSubscriptions();
        const report = yield* Effect.forEach(subscriptions, (row) =>
          Effect.gen(function* () {
            const counts = yield* AgentEventStore.deliveryCounts(row.subscriptionId);
            const deliveries = yield* AgentEventStore.listDeliveries(
              row.subscriptionId,
              Math.max(0, flags.deliveries),
            );
            return {
              id: row.subscriptionId,
              state: row.state === "active" && row.expiresAt <= now ? "expired" : row.state,
              endedReason: row.endedReason,
              client: row.clientLabel,
              session: row.sessionId,
              event: row.eventName,
              arguments: row.argumentsJson,
              callback: redactCallbackUrl(row.callbackUrl),
              refreshBefore: iso(row.expiresAt),
              cursor: formatAgentEventCursor(row.logEpoch, row.watermarkSeq),
              rotating: row.previousSecretUntil !== null && row.previousSecretUntil > now,
              counts,
              deliveries: deliveries.map((delivery) => ({
                eventId: delivery.eventId,
                sequence: delivery.logSeq,
                state: delivery.state,
                attempts: delivery.attempts,
                lastStatus: delivery.lastStatus,
                lastError: delivery.lastError,
                queuedAt: iso(delivery.queuedAt),
                lastAttemptAt: delivery.lastAttemptAt === null ? null : iso(delivery.lastAttemptAt),
                nextAttemptAt: delivery.state === "pending" ? iso(delivery.nextAttemptAt) : null,
              })),
            };
          }),
        );
        if (flags.json) {
          yield* Console.log(
            encodeJson({
              log: { epoch: log.epoch, head: log.headSeq, floor: log.floorSeq },
              retention,
              subscriptions: report,
            }),
          );
          return;
        }
        const lines = [
          `Event log ${log.epoch}: head ${log.headSeq}, floor ${log.floorSeq}.`,
          `Retention: ${retention.rows} payloads (${retention.bytes} bytes); pinned ${retention.pinnedRows} (${retention.pinnedBytes} bytes); soft-cap overrun ${retention.softCapOverrunRows}.`,
          retention.source?.activatedAt == null
            ? "Fact collector inactive."
            : `Fact source ${retention.source.generation}: through ${retention.source.throughSequence}, pinned source rows ${retention.source.pinnedSourceRows}${retention.source.gapSequence === null ? "" : `, gap after ${retention.source.gapSequence}`}.`,
          ...(report.length === 0 ? ["No agent-event subscriptions."] : []),
        ];
        for (const subscription of report) {
          lines.push(
            "",
            `${subscription.id}  ${subscription.state}${subscription.endedReason === null ? "" : ` (${subscription.endedReason})`}`,
            `  client ${subscription.client}, session ${subscription.session}`,
            `  ${subscription.event} ${subscription.arguments} → ${subscription.callback}`,
            `  refreshBefore ${subscription.refreshBefore}, cursor ${subscription.cursor}${subscription.rotating ? ", secret rotating" : ""}`,
            `  deliveries ${
              Object.entries(subscription.counts)
                .map(([state, count]) => `${state} ${count}`)
                .join(", ") || "none"
            }`,
            ...subscription.deliveries.map(
              (delivery) =>
                `    #${delivery.sequence} ${delivery.eventId} ${delivery.state}, ${delivery.attempts} attempt(s), last ${delivery.lastStatus ?? "-"}${delivery.lastError === null ? "" : ` ${delivery.lastError}`}${delivery.lastAttemptAt === null ? "" : ` at ${delivery.lastAttemptAt}`}${delivery.nextAttemptAt === null ? "" : `, next ${delivery.nextAttemptAt}`}`,
            ),
          );
        }
        yield* Console.log(lines.join("\n"));
      }),
      flags.json,
    ),
  ),
);

const withDeriver = Effect.fn("agentEvents.withDeriver")(function* <A, E, R>(
  run: Effect.Effect<A, E, R | FactDeriver.AgentFactDeriver>,
) {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  return yield* run.pipe(
    Effect.provide(
      FactDeriver.layer({ id: descriptor.environmentId, label: descriptor.label }).pipe(
        Layer.provide(Layer.mergeAll(FleetUsers.layer, ProjectionStore.layer, SourceStore.layer)),
      ),
    ),
  );
});

const rebuildCommand = Command.make("rebuild", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription(
    "Rebuild retained local event facts from their original source/checkpoints. Preserves event IDs, payloads and delivery state; changes the replay cursor epoch.",
  ),
  Command.withHandler((flags) =>
    runWithDatabase(
      flags,
      withDeriver(
        Effect.gen(function* () {
          const service = yield* FactDeriver.AgentFactDeriver;
          const result = yield* service.rebuild;
          yield* Console.log(
            flags.json
              ? encodeJson(result)
              : `Rebuilt ${result.restored} retained facts; cursor epoch ${result.cursorEpoch}.`,
          );
        }),
      ),
      flags.json,
    ),
  ),
);

const recoverCommand = Command.make("recover-source", {
  ...authLocationFlags,
  json: jsonFlag,
  generation: Flag.String("generation").pipe(
    Flag.withDescription("The current source generation shown by status."),
  ),
  through: Flag.Int("through").pipe(
    Flag.withDescription("The current derived-through sequence shown by status."),
  ),
}).pipe(
  Command.withDescription(
    "Recover an event source gap with a new generation and a pending-attention snapshot. Intervening transitions stay unknown; stale recovery coordinates are refused.",
  ),
  Command.withHandler((flags) =>
    runWithDatabase(
      flags,
      withDeriver(
        Effect.gen(function* () {
          const service = yield* FactDeriver.AgentFactDeriver;
          const result = yield* service.rebootstrap({
            generation: flags.generation,
            throughSequence: flags.through,
          });
          yield* Console.log(
            flags.json
              ? encodeJson(result)
              : `Recovered source ${result.generation} at snapshot ${result.bootstrapSequence}; intervening transitions remain unknown.`,
          );
        }),
      ),
      flags.json,
    ),
  ),
);

const maintenanceFlags = { ...authLocationFlags, json: jsonFlag };
const expectedFlags = {
  expectedMode: Flag.Literals("expected-mode", ["legacy", "shadow", "adapter"]),
  expectedGeneration: Flag.Int("expected-generation").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
};
const expectedState = (flags: {
  readonly expectedMode: "legacy" | "shadow" | "adapter";
  readonly expectedGeneration: number;
}) => ({ mode: flags.expectedMode, generation: flags.expectedGeneration });

const runCompatibility = Effect.fn("agentEvents.runCompatibility")(function* <A, E, R>(
  flags: CliAuthLocationFlags & { readonly json: boolean },
  run: Effect.Effect<A, E, R | Gateway.GatewayCompatibility>,
) {
  // A maintenance command always names its home. It never silently selects a running/default home.
  if (Option.isNone(flags.baseDir))
    return yield* new AgentEventsCliError({
      detail: "Gateway maintenance requires an explicit --base-dir.",
    });
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
  const result = yield* run.pipe(
    Effect.provide(
      Gateway.layer.pipe(
        Layer.provide(SqlitePersistence.layerConfig),
        Layer.provide(ServerConfig.layer(config)),
      ),
    ),
  );
  yield* Console.log(encodeJson(result));
});

const compatibilityStatus = Command.make("status", maintenanceFlags).pipe(
  Command.withHandler((flags) =>
    runCompatibility(
      flags,
      Effect.flatMap(Gateway.GatewayCompatibility, (service) => service.evidence),
    ),
  ),
);
const compatibilityShadow = Command.make("start-shadow", {
  ...maintenanceFlags,
  ...expectedFlags,
}).pipe(
  Command.withHandler((flags) =>
    runCompatibility(
      flags,
      Effect.flatMap(Gateway.GatewayCompatibility, (service) =>
        service.startShadow(expectedState(flags)),
      ),
    ),
  ),
);
const compatibilityBackup = Command.make("backup", {
  ...maintenanceFlags,
  ...expectedFlags,
  destination: Flag.String("destination"),
  shadowDigest: Flag.String("shadow-digest"),
}).pipe(
  Command.withHandler((flags) =>
    runCompatibility(
      flags,
      Effect.flatMap(Gateway.GatewayCompatibility, (service) =>
        service.createValidatedBackup({
          expected: expectedState(flags),
          destination: flags.destination,
          shadowDigest: flags.shadowDigest,
        }),
      ),
    ),
  ),
);
const compatibilityCutover = Command.make("cutover", {
  ...maintenanceFlags,
  ...expectedFlags,
  backupId: Flag.String("backup-id"),
  manifestDigest: Flag.String("manifest-digest"),
  shadowDigest: Flag.String("shadow-digest"),
}).pipe(
  Command.withHandler((flags) =>
    runCompatibility(
      flags,
      Effect.flatMap(Gateway.GatewayCompatibility, (service) =>
        service.cutover({
          expected: expectedState(flags),
          backupId: flags.backupId,
          manifestDigest: flags.manifestDigest,
          shadowDigest: flags.shadowDigest,
        }),
      ),
    ),
  ),
);
const compatibilityRollback = Command.make("rollback", {
  ...maintenanceFlags,
  ...expectedFlags,
}).pipe(
  Command.withHandler((flags) =>
    runCompatibility(
      flags,
      Effect.flatMap(Gateway.GatewayCompatibility, (service) =>
        service.rollback(expectedState(flags)),
      ),
    ),
  ),
);
const compatibilityCommand = Command.make("compatibility").pipe(
  Command.withDescription(
    "Guarded gateway observe/ACK maintenance for an explicitly selected home; retains legacy tables.",
  ),
  Command.withSubcommands([
    compatibilityStatus,
    compatibilityShadow,
    compatibilityBackup,
    compatibilityCutover,
    compatibilityRollback,
  ]),
);

export const agentEventsCommand = Command.make("agent-events").pipe(
  Command.withDescription("Inspect MCP Events for outside agents and send test probes."),
  Command.withSubcommands([
    probeCommand,
    statusCommand,
    rebuildCommand,
    recoverCommand,
    compatibilityCommand,
  ]),
);
