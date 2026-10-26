import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class NativeUpdateGateError extends Schema.TaggedError<NativeUpdateGateError>()(
  "NativeUpdateGateError",
  {
    reason: Schema.Literals(["reserved", "not-ready", "timeout", "invalid", "check"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Native update admission is unavailable.";
  }
}

export interface NativeUpdateReservationInput {
  readonly id: string;
  readonly timeout: Duration.Input;
  readonly inspectReady: Effect.Effect<boolean, Error>;
  readonly freezeDrafts: (id: string) => Effect.Effect<boolean, Error>;
  readonly verifyFrozenDrafts: (id: string) => Effect.Effect<boolean, Error>;
  readonly thawDrafts: (id: string) => Effect.Effect<void>;
}

export interface NativeUpdateReservation {
  readonly id: string;
  readonly confirm: Effect.Effect<void, NativeUpdateGateError>;
  readonly consume: Effect.Effect<void, NativeUpdateGateError>;
  readonly release: Effect.Effect<void>;
  readonly abortClose: Effect.Effect<void>;
}

type AdmissionMode = "wait" | "reject";
type Phase = "draining" | "reserved" | "checking" | "closing" | "releasing";
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

interface Lease {
  readonly identity: symbol;
}

const CurrentLease = Context.Reference<Lease | undefined>("t3/lan/NativeUpdateGate/Lease", {
  defaultValue: () => undefined,
});

export class NativeUpdateGate extends Context.Service<
  NativeUpdateGate,
  {
    readonly withAdmission: {
      <A, E, R>(effect: Effect.Effect<A, E, R>, mode: "wait"): Effect.Effect<A, E, R>;
      <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        mode?: "reject",
      ): Effect.Effect<A, E | NativeUpdateGateError, R>;
    };
    readonly forkIn: {
      <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        scope: Scope.Scope,
        mode?: "wait",
      ): Effect.Effect<Fiber.Fiber<A, E>, never, R>;
      <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        scope: Scope.Scope,
        mode: "reject",
      ): Effect.Effect<Fiber.Fiber<A, E>, NativeUpdateGateError, R>;
    };
    readonly reserve: (
      input: NativeUpdateReservationInput,
    ) => Effect.Effect<NativeUpdateReservation, NativeUpdateGateError>;
    readonly status: Effect.Effect<{
      readonly phase: "open" | Phase;
      readonly activeCount: number;
    }>;
  }
>()("t3/lan/NativeUpdateGate") {}

const make = Effect.sync(() => {
  const leases = new Set<Lease>();
  let changed = Deferred.makeUnsafe<void>();
  let reservation: { readonly identity: symbol; phase: Phase } | undefined;

  const notify = () => {
    const previous = changed;
    changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  };
  const releaseLease = (lease: Lease) => {
    if (leases.delete(lease)) notify();
  };

  const acquire = Effect.fn("NativeUpdateGate.acquire")(function* (
    mode: AdmissionMode,
    restore: Restore,
  ): Effect.fn.Return<Lease, NativeUpdateGateError> {
    const inherited = yield* CurrentLease;
    while (true) {
      const decision = yield* Effect.sync(() => {
        if (reservation === undefined || (inherited !== undefined && leases.has(inherited))) {
          const lease = { identity: Symbol() };
          leases.add(lease);
          notify();
          return { lease };
        }
        return { waiting: changed };
      });
      if (decision.lease !== undefined) return decision.lease;
      if (mode === "reject") return yield* new NativeUpdateGateError({ reason: "reserved" });
      yield* restore(Deferred.await(decision.waiting));
    }
  });

  const admitted = Effect.fn("NativeUpdateGate.withAdmission")(function <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    mode: AdmissionMode = "reject",
  ) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        acquire(mode, restore),
        (lease) => restore(effect.pipe(Effect.provideService(CurrentLease, lease))),
        (lease) => Effect.sync(() => releaseLease(lease)),
      ),
    );
  });

  function withAdmission<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    mode: "wait",
  ): Effect.Effect<A, E, R>;
  function withAdmission<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    mode?: "reject",
  ): Effect.Effect<A, E | NativeUpdateGateError, R>;
  function withAdmission<A, E, R>(effect: Effect.Effect<A, E, R>, mode: AdmissionMode = "reject") {
    return admitted(effect, mode);
  }

  const forkAdmitted = Effect.fn("NativeUpdateGate.forkIn")(function <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    scope: Scope.Scope,
    mode: AdmissionMode = "wait",
  ) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const lease = yield* acquire(mode, restore);
        return yield* effect.pipe(
          Effect.provideService(CurrentLease, lease),
          Effect.forkIn(scope),
          Effect.tap((fiber) =>
            // Completion observers also run for children interrupted before their effect starts.
            Effect.sync(() => {
              fiber.addObserver(() => releaseLease(lease));
            }),
          ),
          Effect.onError(() => Effect.sync(() => releaseLease(lease))),
        );
      }),
    );
  });

  function forkIn<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    scope: Scope.Scope,
    mode?: "wait",
  ): Effect.Effect<Fiber.Fiber<A, E>, never, R>;
  function forkIn<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    scope: Scope.Scope,
    mode: "reject",
  ): Effect.Effect<Fiber.Fiber<A, E>, NativeUpdateGateError, R>;
  function forkIn<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    scope: Scope.Scope,
    mode: AdmissionMode = "wait",
  ) {
    return forkAdmitted(effect, scope, mode);
  }

  const reserve = Effect.fn("NativeUpdateGate.reserve")(function (
    input: NativeUpdateReservationInput,
  ) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const inherited = yield* CurrentLease;
        const own = yield* Effect.sync(() => {
          if (reservation !== undefined || (inherited !== undefined && leases.has(inherited)))
            return undefined;
          const next = { identity: Symbol(), phase: "draining" as Phase };
          reservation = next;
          notify();
          return next;
        });
        if (own === undefined) return yield* new NativeUpdateGateError({ reason: "reserved" });
        let freezeAttempted = false;
        let releasing = false;
        const released = Deferred.makeUnsafe<void>();

        const release = Effect.fn("NativeUpdateGate.release")(function* (abortClose: boolean) {
          if (reservation !== own || (own.phase === "closing" && !abortClose)) return;
          if (releasing) return yield* Deferred.await(released);
          releasing = true;
          own.phase = "releasing";
          notify();
          yield* Effect.suspend(() =>
            freezeAttempted ? input.thawDrafts(input.id) : Effect.void,
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (reservation === own) reservation = undefined;
                Deferred.doneUnsafe(released, Effect.void);
                notify();
              }),
            ),
          );
        }, Effect.uninterruptible);

        const requireReady = Effect.fn("NativeUpdateGate.requireReady")(function* (
          check: Effect.Effect<boolean, Error>,
        ) {
          const ready = yield* check.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.fail(
                    new NativeUpdateGateError({ reason: "check", cause: Cause.squash(cause) }),
                  ),
            ),
          );
          if (!ready) return yield* new NativeUpdateGateError({ reason: "not-ready" });
        });

        const bounded = Effect.fn("NativeUpdateGate.bounded")(function* (
          check: Effect.Effect<void, NativeUpdateGateError>,
        ) {
          const outcome = yield* check.pipe(Effect.timeoutOption(input.timeout));
          if (Option.isNone(outcome))
            return yield* new NativeUpdateGateError({ reason: "timeout" });
        });

        const verify = Effect.gen(function* () {
          yield* requireReady(input.inspectReady);
          yield* requireReady(input.verifyFrozenDrafts(input.id));
        });
        const confirm = Effect.fn("NativeUpdateGate.confirm")(function (consume: boolean) {
          return Effect.uninterruptibleMask((restoreConfirm) =>
            Effect.gen(function* () {
              if (reservation !== own || own.phase !== "reserved")
                return yield* new NativeUpdateGateError({ reason: "invalid" });
              own.phase = "checking";
              notify();
              yield* restoreConfirm(bounded(verify)).pipe(Effect.onError(() => release(false)));
              if (reservation !== own || own.phase !== "checking")
                return yield* new NativeUpdateGateError({ reason: "invalid" });
              own.phase = consume ? "closing" : "reserved";
              notify();
            }),
          );
        });

        const prepare = Effect.gen(function* () {
          while (leases.size > 0) yield* Deferred.await(changed);
          yield* requireReady(input.inspectReady);
          freezeAttempted = true;
          yield* requireReady(input.freezeDrafts(input.id));
          yield* verify;
        });
        yield* restore(bounded(prepare)).pipe(Effect.onError(() => release(false)));
        own.phase = "reserved";
        notify();
        return {
          id: input.id,
          confirm: confirm(false),
          consume: confirm(true),
          release: release(false),
          abortClose: release(true),
        } satisfies NativeUpdateReservation;
      }),
    );
  });

  return NativeUpdateGate.of({
    withAdmission,
    forkIn,
    reserve,
    status: Effect.sync(() => ({ phase: reservation?.phase ?? "open", activeCount: leases.size })),
  });
});

export const layer = Layer.effect(NativeUpdateGate, make);

export const captureAdmission = Effect.fn("NativeUpdateGate.captureAdmission")(function* () {
  const gate = yield* Effect.serviceOption(NativeUpdateGate);
  // Admission already owns its span; only the service instance is captured, preserving caller leases.
  return {
    withAdmission: Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* Option.isNone(gate) ? effect : gate.value.withAdmission(effect, "wait");
    }),
    forkIn: Effect.fnUntraced(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      scope: Scope.Scope,
    ) {
      return yield* Option.isNone(gate)
        ? Effect.forkIn(effect, scope)
        : gate.value.forkIn(effect, scope, "wait");
    }),
  };
});
