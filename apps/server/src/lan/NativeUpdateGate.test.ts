import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as NativeUpdateGate from "./NativeUpdateGate.ts";

const checks = (
  overrides: Partial<NativeUpdateGate.NativeUpdateReservationInput> = {},
): NativeUpdateGate.NativeUpdateReservationInput => ({
  id: "synthetic-update",
  timeout: "1 second",
  inspectReady: Effect.succeed(true),
  freezeDrafts: () => Effect.succeed(true),
  verifyFrozenDrafts: () => Effect.succeed(true),
  thawDrafts: () => Effect.void,
  ...overrides,
});

describe("NativeUpdateGate", () => {
  it.effect("preserves admission and scoped forks without the optional service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const admission = yield* NativeUpdateGate.captureAdmission();
        assert.strictEqual(yield* admission.withAdmission(Effect.succeed(7)), 7);
        const scope = yield* Effect.scope;
        const child = yield* admission.forkIn(Effect.succeed(9), scope);
        assert.strictEqual(yield* Fiber.join(child), 9);
      }),
    ),
  );

  it.effect(
    "drains admitted work, rejects new starts, and resumes waiters only after release",
    () =>
      Effect.gen(function* () {
        const gate = yield* NativeUpdateGate.NativeUpdateGate;
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const holder = yield* gate
          .withAdmission(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const pending = yield* gate
          .reserve(checks())
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.deepStrictEqual(yield* gate.status, { phase: "draining", activeCount: 1 });
        assert.strictEqual(
          (yield* gate.withAdmission(Effect.void).pipe(Effect.flip)).reason,
          "reserved",
        );
        let started = false;
        const waiter = yield* gate
          .withAdmission(
            Effect.sync(() => {
              started = true;
            }),
            "wait",
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isFalse(started);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(holder);
        const reservation = yield* Fiber.join(pending);
        assert.deepStrictEqual(yield* gate.status, { phase: "reserved", activeCount: 0 });
        assert.isFalse(started);
        yield* reservation.release;
        yield* Fiber.join(waiter);
        assert.isTrue(started);
        assert.deepStrictEqual(yield* gate.status, { phase: "open", activeCount: 0 });
      }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("lets nested admitted work finish after reservation closes admission", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      const entered = yield* Deferred.make<void>();
      const continueNested = yield* Deferred.make<void>();
      const holder = yield* gate
        .withAdmission(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(continueNested);
            return yield* gate.withAdmission(Effect.succeed("nested-completed"));
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const pending = yield* gate
        .reserve(checks())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(continueNested, undefined);
      assert.strictEqual(yield* Fiber.join(holder), "nested-completed");
      const reservation = yield* Fiber.join(pending);
      yield* reservation.release;
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("does not authorize a raw child using its expired inherited lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* NativeUpdateGate.NativeUpdateGate;
        const scope = yield* Effect.scope;
        const continueChild = yield* Deferred.make<void>();
        const child = yield* gate.withAdmission(
          Deferred.await(continueChild).pipe(
            Effect.andThen(gate.withAdmission(Effect.succeed("must-not-run"))),
            Effect.flip,
            Effect.forkIn(scope),
          ),
        );
        const reservation = yield* gate.reserve(checks());
        yield* Deferred.succeed(continueChild, undefined);
        assert.strictEqual((yield* Fiber.join(child)).reason, "reserved");
        yield* reservation.release;
        assert.strictEqual(yield* gate.withAdmission(Effect.succeed("reopened")), "reopened");
      }),
    ).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("transfers a counted lease before a scoped child outlives its caller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* NativeUpdateGate.NativeUpdateGate;
        const scope = yield* Effect.scope;
        const continueChild = yield* Deferred.make<void>();
        const child = yield* gate.withAdmission(
          gate.forkIn(
            Deferred.await(continueChild).pipe(
              Effect.andThen(gate.withAdmission(Effect.succeed(42))),
            ),
            scope,
          ),
        );
        assert.strictEqual((yield* gate.status).activeCount, 1);
        const pending = yield* gate
          .reserve(checks())
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.strictEqual((yield* gate.status).phase, "draining");
        yield* Deferred.succeed(continueChild, undefined);
        assert.strictEqual(yield* Fiber.join(child), 42);
        const reservation = yield* Fiber.join(pending);
        assert.strictEqual((yield* gate.status).activeCount, 0);
        yield* reservation.release;
      }),
    ).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("releases transferred admission when a child is interrupted before starting", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      const closedScope = yield* Scope.make();
      yield* Scope.close(closedScope, Exit.void);
      let started = false;
      const child = yield* gate.forkIn(
        Effect.sync(() => {
          started = true;
        }),
        closedScope,
      );
      assert.isTrue(Exit.isFailure(yield* Fiber.await(child)));
      assert.isFalse(started);
      assert.strictEqual((yield* gate.status).activeCount, 0);
      const reservation = yield* gate.reserve(checks());
      yield* reservation.release;
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("cancelling a drain reopens admission without interrupting its existing work", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const holder = yield* gate
        .withAdmission(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const pending = yield* gate
        .reserve(checks())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(pending);
      assert.deepStrictEqual(yield* gate.status, { phase: "open", activeCount: 1 });
      assert.strictEqual(yield* gate.withAdmission(Effect.succeed("accepted")), "accepted");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(holder);
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("bounds a drain with TestClock and leaves admitted work running", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const holder = yield* gate
        .withAdmission(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const pending = yield* gate.reserve(checks()).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(pending)).reason, "timeout");
      assert.deepStrictEqual(yield* gate.status, { phase: "open", activeCount: 1 });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(holder);
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("thaws failed or cancelled draft freezing and permits another reservation", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      let thaws = 0;
      const thawDrafts = () =>
        Effect.sync(() => {
          thaws++;
        });
      const refusal = yield* gate
        .reserve(
          checks({
            freezeDrafts: () => Effect.succeed(false),
            thawDrafts,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(refusal.reason, "not-ready");
      assert.strictEqual(thaws, 1);
      const freezing = yield* Deferred.make<void>();
      const pending = yield* gate
        .reserve(
          checks({
            freezeDrafts: () =>
              Deferred.succeed(freezing, undefined).pipe(Effect.andThen(Effect.never)),
            thawDrafts,
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(freezing);
      yield* Fiber.interrupt(pending);
      assert.strictEqual(thaws, 2);
      assert.strictEqual((yield* gate.status).phase, "open");
      const reservation = yield* gate.reserve(checks({ thawDrafts }));
      yield* reservation.release;
      yield* reservation.release;
      assert.strictEqual(thaws, 3);
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("releases failed readiness checks before and after freezing", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      let thaws = 0;
      const thawDrafts = () =>
        Effect.sync(() => {
          thaws++;
        });
      const inspection = yield* gate
        .reserve(
          checks({
            inspectReady: Effect.fail(
              new NativeUpdateGate.NativeUpdateGateError({ reason: "check" }),
            ),
            thawDrafts,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(inspection.reason, "check");
      assert.strictEqual(thaws, 0);
      const verification = yield* gate
        .reserve(
          checks({
            verifyFrozenDrafts: () => Effect.succeed(false),
            thawDrafts,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(verification.reason, "not-ready");
      assert.strictEqual(thaws, 1);
      assert.strictEqual((yield* gate.status).phase, "open");
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("rechecks readiness and frozen drafts for confirmation and consumption", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      for (const operation of ["confirm", "consume"] as const) {
        for (const failInspection of [true, false]) {
          let ready = true;
          let frozen = true;
          let thaws = 0;
          const reservation = yield* gate.reserve(
            checks({
              inspectReady: Effect.sync(() => ready),
              verifyFrozenDrafts: () => Effect.sync(() => frozen),
              thawDrafts: () =>
                Effect.sync(() => {
                  thaws++;
                }),
            }),
          );
          if (failInspection) ready = false;
          else frozen = false;
          assert.strictEqual((yield* reservation[operation].pipe(Effect.flip)).reason, "not-ready");
          assert.strictEqual(thaws, 1);
          assert.strictEqual((yield* gate.status).phase, "open");
        }
      }
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("keeps consumed admission closed until the explicit desktop abort", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      let thaws = 0;
      const reservation = yield* gate.reserve(
        checks({
          thawDrafts: () =>
            Effect.sync(() => {
              thaws++;
            }),
        }),
      );
      yield* reservation.confirm;
      yield* reservation.consume;
      yield* reservation.release;
      assert.deepStrictEqual(yield* gate.status, { phase: "closing", activeCount: 0 });
      assert.strictEqual(thaws, 0);
      assert.strictEqual(
        (yield* gate.withAdmission(Effect.void).pipe(Effect.flip)).reason,
        "reserved",
      );
      yield* reservation.abortClose;
      assert.strictEqual(thaws, 1);
      assert.strictEqual((yield* gate.status).phase, "open");
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );

  it.effect("cannot consume a reservation released while final verification is in flight", () =>
    Effect.gen(function* () {
      const gate = yield* NativeUpdateGate.NativeUpdateGate;
      const checking = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      let pause = false;
      const reservation = yield* gate.reserve(
        checks({
          verifyFrozenDrafts: () =>
            pause
              ? Deferred.succeed(checking, undefined).pipe(
                  Effect.andThen(Deferred.await(finishCheck)),
                  Effect.as(true),
                )
              : Effect.succeed(true),
        }),
      );
      pause = true;
      const consuming = yield* reservation.consume.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(checking);
      yield* reservation.release;
      yield* Deferred.succeed(finishCheck, undefined);
      assert.strictEqual((yield* Fiber.join(consuming)).reason, "invalid");
      assert.strictEqual((yield* gate.status).phase, "open");
    }).pipe(Effect.provide(NativeUpdateGate.layer)),
  );
});
