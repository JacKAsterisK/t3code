import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class ApprovalAdmissionGate extends Context.Service<
  ApprovalAdmissionGate,
  {
    readonly withGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/auth/ApprovalAdmissionGate") {}

const make = Effect.gen(function* () {
  const gate = yield* Semaphore.make(1);
  const inside = Context.Reference<boolean>("t3/auth/ApprovalAdmissionGate/inside", {
    defaultValue: () => false,
  });
  const withGate: ApprovalAdmissionGate["Service"]["withGate"] = (effect) =>
    Effect.flatMap(inside, (held) =>
      held ? effect : gate.withPermit(effect.pipe(Effect.provideService(inside, true))),
    );
  return ApprovalAdmissionGate.of({ withGate });
});

export const layer = Layer.effect(ApprovalAdmissionGate, make);
