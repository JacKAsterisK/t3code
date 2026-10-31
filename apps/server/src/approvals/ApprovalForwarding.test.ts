import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  ApprovalReceiptResult,
  OrchestratorMcpFailure,
  type ApprovalRespondInput,
  type AuthClientSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Authority from "../auth/ApprovalAuthority.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Peers from "../peer/PeerMcpClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Wire from "../../../../packages/contracts/src/approvalForwarding.ts";
import * as Forwarding from "./ApprovalForwarding.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { ApprovalTestHooks } from "./ApprovalTestHooks.ts";

const decodeRequest = Schema.decodeUnknownEffect(Wire.LinkApprovalRequest);
const decodeReceipt = Schema.decodeUnknownEffect(ApprovalReceiptResult);
const input: ApprovalRespondInput = {
  action: "respond",
  environmentId: EnvironmentId.make("b"),
  threadId: ThreadId.make("thread"),
  requestId: RuntimeRequestId.make("request"),
  clientRequestId: "same-retry-key",
  decision: "accept",
  expected: {
    requestIncarnation: "incarnation",
    providerSessionId: "native",
    providerGeneration: "generation",
    presentationRevision: 1,
    presentationDigest: "digest",
  },
  consent: {
    effectiveScope: "turn",
    grantDigest: "grant",
    onBehalfOf: "Dan",
    authorization: "These exact permissions for this turn.",
  },
};
const invocation: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("a"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session",
  thread: undefined,
  linkedEnvironments: true,
  client: { sessionId: "source-session", label: "Assistant", access: "full-access" },
};
const fixture = Effect.fn("ForwardingFixture.make")(function* (
  options: {
    dropCommitReply?: boolean;
    refuseCommitBeforeSend?: boolean;
    prepareRefusal?: "thread_not_delegated";
    unavailablePrepare?: boolean;
    expiresAt?: number;
    committedState?: "committed" | "delivery_unknown";
    afterPrepare?: Effect.Effect<void>;
    beforeCommit?: Effect.Effect<void>;
  } = {},
) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const notices = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
  const reconciled = yield* Queue.unbounded<void>();
  const drainedNotices = yield* Queue.unbounded<void>();
  const committedKeys = yield* Queue.unbounded<string>();
  const sweeps = yield* Ref.make(0);
  const refuseCommit = yield* Ref.make(options.refuseCommitBeforeSend ?? false);
  const corruptCancel = yield* Ref.make<string | undefined>(undefined);
  const issued = [
    {
      sessionId: AuthSessionId.make("source-session"),
      method: "bearer-access-token",
      subject: "mcp-client:local",
      expiresAt: DateTime.makeUnsafe(options.expiresAt ?? 100000),
      scopes: ["orchestration:read", "orchestration:operate", "orchestration:approve"],
    },
  ] as unknown as ReadonlyArray<AuthClientSession>;
  const sessionStore = Layer.mock(SessionStore.SessionStore)({
    cookieName: "fixture",
    legacyCookieName: undefined,
    listActive: () => Effect.succeed(issued),
    streamChanges: Stream.fromQueue(notices),
    notifyScopeChange: (sessionId) =>
      Queue.offer(notices, { type: "clientRemoved", sessionId }).pipe(Effect.asVoid),
  });
  const remote = new Map<string, ApprovalReceiptResult>();
  const cancelled = new Set<string>();
  const commits = yield* Ref.make(0);
  const requests: Wire.LinkApprovalRequest[] = [];
  const statusHold = yield* Ref.make<
    | {
        readonly entered: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
        readonly key?: string;
      }
    | undefined
  >(undefined);
  const readIdentities: Array<string | undefined> = [];
  const peer = Layer.succeed(
    Peers.PeerMcpClient,
    Peers.PeerMcpClient.of({
      call: (request) =>
        Effect.gen(function* () {
          assert.equal(request.environmentId, "b");
          if (request.tool === "t3_approval_request") {
            assert.isFalse(request.writes);
            readIdentities.push(request.initiatingClientId);
            const view = { answerable: { via: "t3_approval_request" }, receipts: [] };
            return (
              (request.arguments as { action: string }).action === "list"
                ? { requests: [view] }
                : view
            ) as (typeof request.success)["Type"];
          }
          assert.equal(request.tool, "t3_link_approval_request");
          const args = yield* decodeRequest(request.arguments).pipe(Effect.orDie);
          requests.push(args);
          let receipt = remote.get(args.clientRequestId) ?? null;
          if (args.operation === "prepare") {
            assert.isTrue(request.writes);
            if (options.unavailablePrepare)
              return yield* new OrchestratorMcpFailure({
                code: "forwarding_unavailable",
                message: "Fixture prepare did not reach B.",
              });
            if (options.prepareRefusal !== undefined)
              return yield* new OrchestratorMcpFailure({
                code: options.prepareRefusal,
                message: "Fixture definite refusal.",
              });
            assert.equal(args.proposal.input.clientRequestId, args.clientRequestId);
            assert.equal(args.proposal.sourceEnvironmentId, "a");
            if (receipt === null) {
              receipt = {
                receiptId: `receiver:${args.clientRequestId}`,
                commandId: `native:${args.clientRequestId}`,
                state: cancelled.has(args.clientRequestId) ? "refused" : "prepared",
                decision: args.proposal.input.decision,
                effectiveScope: args.proposal.input.consent.effectiveScope,
                replayed: false,
              };
              remote.set(args.clientRequestId, receipt);
            }
            yield* options.afterPrepare ?? Effect.void;
          }
          if (args.operation === "commit" && args.cancel === true) {
            assert.isFalse(request.writes);
            if ((yield* Ref.get(corruptCancel)) === args.clientRequestId)
              return {
                environmentId: "b",
                forwarderReceiptId: args.forwarderReceiptId,
                operationDigest: args.operationDigest,
                receipt:
                  receipt === null ? null : { ...receipt, receiptId: "inconsistent-receipt" },
              } as (typeof request.success)["Type"];
            cancelled.add(args.clientRequestId);
            if (receipt?.state === "prepared") {
              receipt = { ...receipt, state: "refused", failureCode: "authority_revoked" };
              remote.set(args.clientRequestId, receipt);
            }
          } else if (args.operation === "commit") {
            assert.isTrue(request.writes);
            if (yield* Ref.get(refuseCommit))
              return yield* new OrchestratorMcpFailure({
                code: "forwarding_unavailable",
                message: "Fixture refused before sending.",
              });
            yield* request.beforeSend ?? Effect.void;
            yield* options.beforeCommit ?? Effect.void;
            if (receipt?.state === "prepared") {
              yield* Ref.update(commits, (n) => n + 1);
              yield* Queue.offer(committedKeys, args.clientRequestId);
              receipt = { ...receipt, state: options.committedState ?? "committed", sequence: 7 };
              remote.set(args.clientRequestId, receipt);
            }
            if (options.dropCommitReply)
              return yield* new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Fixture lost the commit reply.",
              });
          } else if (args.operation === "status") {
            assert.isFalse(request.writes);
            const hold = yield* Ref.modify(statusHold, (current) =>
              current !== undefined &&
              (current.key === undefined || current.key === args.clientRequestId)
                ? [current, undefined]
                : [undefined, current],
            );
            if (hold !== undefined) {
              yield* Deferred.succeed(hold.entered, undefined);
              yield* Deferred.await(hold.release);
            }
          }
          assert.isTrue(Object.is(request.success, Schema.Unknown));
          return {
            environmentId: "b",
            forwarderReceiptId: args.forwarderReceiptId,
            operationDigest: args.operationDigest,
            receipt,
          } as (typeof request.success)["Type"];
        }),
    }),
  );
  const services = yield* Layer.build(
    Forwarding.layer.pipe(
      Layer.provideMerge(Authority.layer),
      Layer.provideMerge(sessionStore),
      Layer.provide(peer),
      Layer.provide(
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("a")),
        }),
      ),
      Layer.provide(
        Layer.succeed(ApprovalTestHooks, {
          afterForwardReconcile: Ref.update(sweeps, (n) => n + 1).pipe(
            Effect.andThen(Queue.offer(reconciled, undefined)),
            Effect.asVoid,
          ),
          afterForwardNotice: Queue.offer(drainedNotices, undefined).pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  yield* Queue.take(reconciled);
  const service = Context.get(services, Forwarding.ApprovalForwarding);
  const authority = Context.get(services, Authority.ApprovalAuthority);
  yield* authority.register({
    sessionId: "source-session",
    applicationId: "app",
    grantorSubject: "owner",
    enabled: true,
    runtimeModeCeiling: "full-access",
  });
  const call = (value: Parameters<typeof service.call>[0], scope = invocation) =>
    service.call(value).pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
  return {
    call,
    readIdentities,
    authority,
    commits,
    requests,
    sql,
    remote,
    cancelled,
    refuseCommit,
    corruptCancel,
    reconciled,
    notices,
    drainedNotices,
    committedKeys,
    sweeps,
    notice: Queue.offer(notices, {
      type: "clientRemoved",
      sessionId: AuthSessionId.make("source-session"),
    }).pipe(Effect.andThen(Queue.take(reconciled))),
    holdNextStatus: (
      entered: Deferred.Deferred<void>,
      release: Deferred.Deferred<void>,
      key?: string,
    ) => Ref.set(statusHold, { entered, release, ...(key === undefined ? {} : { key }) }),
  };
});
const dependencies = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);

it.effect(
  "lost commit replies reconcile the same remote operation without another native commitment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ dropCommitReply: true });
      const first = yield* decodeReceipt(yield* f.call(input));
      assert.equal(first.state, "delivery_unknown");
      assert.isNotNull(first.forwarding?.receiptId);
      const retry = yield* decodeReceipt(yield* f.call(input));
      assert.equal(retry.state, "committed");
      assert.equal(retry.receiptId, first.receiptId);
      assert.equal(retry.forwarding?.receiptId, first.forwarding?.receiptId);
      assert.equal(yield* Ref.get(f.commits), 1);
      const conflict = yield* f.call({ ...input, decision: "decline" }).pipe(Effect.flip);
      assert.equal(conflict.code, "idempotency_conflict");
      yield* f.authority.remove("source-session", false);
      const status = yield* decodeReceipt(
        yield* f.call({
          action: "status",
          environmentId: input.environmentId!,
          threadId: input.threadId,
          clientRequestId: input.clientRequestId,
        }),
      );
      assert.equal(status.state, "committed");
      assert.equal(yield* Ref.get(f.commits), 1);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("removing source approval while preparation is in flight cancels it before commit", () =>
  Effect.gen(function* () {
    const prepared = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = yield* fixture({
      afterPrepare: Deferred.succeed(prepared, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const pending = yield* f.call(input).pipe(Effect.forkScoped);
    yield* Deferred.await(prepared);
    yield* f.authority.remove("source-session", false);
    yield* Deferred.succeed(release, undefined);
    const result = yield* decodeReceipt(yield* Fiber.join(pending));
    assert.equal(result.state, "refused");
    assert.equal(yield* Ref.get(f.commits), 0);
    assert.isTrue(
      f.requests.some((request) => request.operation === "commit" && request.cancel === true),
    );
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "every linked caller, including Full access, is refused before a second forwarding hop",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* f
        .call(input, {
          ...invocation,
          client: { ...invocation.client!, linked: true, access: "full-access" },
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "forwarding_chain_refused");
      assert.equal(f.requests.length, 0);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("a delayed prepared status cannot replace a later committed receiver outcome", () =>
  Effect.gen(function* () {
    const commitEntered = yield* Deferred.make<void>();
    const commitRelease = yield* Deferred.make<void>();
    const statusEntered = yield* Deferred.make<void>();
    const statusRelease = yield* Deferred.make<void>();
    const f = yield* fixture({
      beforeCommit: Deferred.succeed(commitEntered, undefined).pipe(
        Effect.andThen(Deferred.await(commitRelease)),
      ),
    });
    const first = yield* f.call(input).pipe(Effect.forkScoped);
    yield* Deferred.await(commitEntered);
    yield* f.holdNextStatus(statusEntered, statusRelease);
    const stale = yield* f
      .call({
        action: "status",
        environmentId: input.environmentId!,
        threadId: input.threadId,
        clientRequestId: input.clientRequestId,
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(statusEntered);
    yield* Deferred.succeed(commitRelease, undefined);
    assert.equal((yield* decodeReceipt(yield* Fiber.join(first))).state, "committed");
    yield* Deferred.succeed(statusRelease, undefined);
    assert.equal((yield* decodeReceipt(yield* Fiber.join(stale))).state, "committed");
    assert.equal(yield* Ref.get(f.commits), 1);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("source removal reconciles an admitted operation whose commit never left A", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ refuseCommitBeforeSend: true });
    const first = yield* decodeReceipt(yield* f.call(input));
    assert.equal(first.state, "delivery_unknown");
    assert.equal(yield* Ref.get(f.commits), 0);
    yield* f.authority.remove("source-session", false);
    yield* Queue.take(f.reconciled);
    assert.equal(f.cancelled.size, 1);
    assert.equal([...f.remote.values()][0]?.state, "refused");
    const durable = (yield* f.sql<{
      state: string;
    }>`SELECT state FROM agent_approval_receipts WHERE receipt_id = ${first.receiptId}`)[0]!;
    assert.equal(durable.state, "refused");
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "a respond retry holding old prepared status cannot re-admit over a recorded commit",
  () =>
    Effect.gen(function* () {
      const commitEntered = yield* Deferred.make<void>();
      const commitRelease = yield* Deferred.make<void>();
      const statusEntered = yield* Deferred.make<void>();
      const statusRelease = yield* Deferred.make<void>();
      const f = yield* fixture({
        beforeCommit: Deferred.succeed(commitEntered, undefined).pipe(
          Effect.andThen(Deferred.await(commitRelease)),
        ),
      });
      const first = yield* f.call(input).pipe(Effect.forkScoped);
      yield* Deferred.await(commitEntered);
      yield* f.holdNextStatus(statusEntered, statusRelease);
      const stale = yield* f.call(input).pipe(Effect.forkScoped);
      yield* Deferred.await(statusEntered);
      yield* Deferred.succeed(commitRelease, undefined);
      assert.equal((yield* decodeReceipt(yield* Fiber.join(first))).state, "committed");
      yield* Ref.set(f.refuseCommit, true);
      yield* Deferred.succeed(statusRelease, undefined);
      assert.equal((yield* decodeReceipt(yield* Fiber.join(stale))).state, "committed");
      assert.equal(
        f.requests.filter((r) => r.operation === "commit" && r.cancel !== true).length,
        1,
      );
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("terminal B uncertainty stops cancellation and late replies cannot replace it", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ committedState: "delivery_unknown" });
    const first = yield* decodeReceipt(yield* f.call(input));
    assert.equal(first.state, "delivery_unknown");
    yield* f.sql`UPDATE agent_approval_forward_operations SET cancelled = 1 WHERE receipt_id = ${first.receiptId}`;
    const before = f.requests.length;
    yield* f.notice;
    yield* f.notice;
    assert.equal(f.requests.length, before);
    const [key, receipt] = [...f.remote.entries()][0]!;
    f.remote.set(key, { ...receipt, state: "committed" });
    const status = yield* decodeReceipt(
      yield* f.call({
        action: "status",
        environmentId: input.environmentId!,
        threadId: input.threadId,
        clientRequestId: input.clientRequestId,
      }),
    );
    assert.equal(status.state, "delivery_unknown");
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("one inconsistent peer reply cannot starve another pending cancellation", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ refuseCommitBeforeSend: true });
    yield* f.call(input);
    yield* f.call({ ...input, clientRequestId: "second-operation" });
    const firstPrepare = f.requests.find((r) => r.operation === "prepare")!;
    yield* Ref.set(f.corruptCancel, firstPrepare.clientRequestId);
    yield* f.sql`UPDATE agent_approval_forward_operations SET cancelled = 1`;
    yield* f.authority.remove("source-session", false);
    yield* Queue.take(f.reconciled);
    assert.equal(f.cancelled.size, 1);
    assert.equal([...f.remote.values()].filter((r) => r.state === "refused").length, 1);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("a definite destination refusal terminates preparation with its actual code", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ prepareRefusal: "thread_not_delegated" });
    const receipt = yield* decodeReceipt(yield* f.call(input));
    assert.equal(receipt.state, "refused");
    assert.equal(receipt.failureCode, "thread_not_delegated");
    assert.equal(yield* Ref.get(f.commits), 0);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("background reconciliation retries only an identical admitted prepared commit", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ refuseCommitBeforeSend: true });
    const first = yield* decodeReceipt(yield* f.call(input));
    const original = f.requests.find((r) => r.operation === "commit" && r.cancel !== true)!;
    yield* Ref.set(f.refuseCommit, false);
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(f.reconciled);
    const row = (yield* f.sql<{
      state: string;
    }>`SELECT state FROM agent_approval_receipts WHERE receipt_id = ${first.receiptId}`)[0]!;
    assert.equal(row.state, "committed");
    assert.equal(yield* Ref.get(f.commits), 1);
    assert.deepEqual(
      f.requests.filter((r) => r.operation === "commit" && r.cancel !== true),
      [original, original],
    );
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);
it.effect(
  "a forgotten destination after admission stays uncertain and is never sent as a new operation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ dropCommitReply: true });
      const first = yield* decodeReceipt(yield* f.call(input));
      assert.equal(yield* Ref.get(f.commits), 1);
      f.remote.clear();
      yield* f.authority.remove("source-session", false);
      yield* Queue.take(f.reconciled);
      const row = (yield* f.sql<{
        state: string;
        failure_code: string | null;
        reconcile_done: number;
      }>`SELECT r.state, r.failure_code, f.reconcile_done FROM agent_approval_receipts r JOIN agent_approval_forward_operations f ON f.receipt_id = r.receipt_id WHERE r.receipt_id = ${first.receiptId}`)[0]!;
      assert.equal(row.state, "delivery_unknown");
      assert.isNull(row.failure_code);
      assert.equal(row.reconcile_done, 1);
      yield* f.notice;
      assert.equal(yield* Ref.get(f.commits), 1);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
it.effect("session notices preserve network backoff for still-authorized operations", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ refuseCommitBeforeSend: true });
    yield* f.call(input);
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(f.reconciled);
    const before = f.requests.length;
    for (let n = 0; n < 50; n++) yield* f.notice;
    assert.equal(f.requests.length, before);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect.each(["absent", "prepared"] as const)(
  "unadmitted %s operations retire after bounded age with the same cancellation tombstone",
  (remote) =>
    Effect.gen(function* () {
      const f = yield* fixture({
        expiresAt: 7 * 24 * 60 * 60 * 1000,
        ...(remote === "absent"
          ? { unavailablePrepare: true }
          : { afterPrepare: Effect.interrupt }),
      });
      yield* f.call(input).pipe(Effect.exit);
      yield* f.sql`UPDATE agent_approval_receipts SET created_at = ${-48 * 60 * 60 * 1000} WHERE role = 'forwarder'`;
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(f.reconciled);
      const row = (yield* f.sql<{
        state: string;
        reconcile_done: number;
        commit_started: number;
      }>`SELECT r.state, f.reconcile_done, f.commit_started FROM agent_approval_receipts r JOIN agent_approval_forward_operations f ON f.receipt_id = r.receipt_id`)[0]!;
      assert.equal(row.state, "refused");
      assert.equal(row.reconcile_done, 1);
      assert.equal(row.commit_started, 0);
      assert.equal(f.cancelled.size, 1);
      assert.equal(yield* Ref.get(f.commits), 0);
      const before = f.requests.length;
      yield* f.notice;
      assert.equal(f.requests.length, before);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
it.effect(
  "transient source authority lookup never cancels or sends an admitted prepared operation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ refuseCommitBeforeSend: true });
      yield* f.call(input);
      yield* f.sql`ALTER TABLE agent_approval_authorizations RENAME TO fixture_unavailable_authority`;
      yield* f.notice.pipe(
        Effect.ensuring(
          f.sql`ALTER TABLE fixture_unavailable_authority RENAME TO agent_approval_authorizations`.pipe(
            Effect.orDie,
          ),
        ),
      );
      assert.equal(f.cancelled.size, 0);
      assert.equal(yield* Ref.get(f.commits), 0);
      yield* Ref.set(f.refuseCommit, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(f.reconciled);
      assert.equal(yield* Ref.get(f.commits), 1);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
it.effect(
  "a paused peer drains a notice burst with bounded sweeps while a healthy operation progresses",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ refuseCommitBeforeSend: true });
      yield* f.call(input);
      yield* f.call({ ...input, clientRequestId: "healthy-operation" });
      yield* Ref.set(f.refuseCommit, false);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* f.holdNextStatus(
        entered,
        release,
        f.requests.find((r) => r.operation === "prepare")!.clientRequestId,
      );
      const tick = yield* TestClock.adjust("30 seconds").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const healthy = yield* Queue.take(f.committedKeys);
      assert.equal(
        healthy,
        f.requests.filter((r) => r.operation === "prepare")[1]!.clientRequestId,
      );
      const before = yield* Ref.get(f.sweeps);
      for (let n = 0; n < 500; n++)
        yield* Queue.offer(f.notices, {
          type: "clientRemoved",
          sessionId: AuthSessionId.make("source-session"),
        });
      for (let n = 0; n < 500; n++) yield* Queue.take(f.drainedNotices);
      assert.equal(Queue.sizeUnsafe(f.notices), 0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(tick);
      yield* Queue.take(f.reconciled);
      yield* f.notice;
      yield* f.notice;
      assert.isAtMost((yield* Ref.get(f.sweeps)) - before, 5);
      assert.equal(f.requests.filter((r) => r.operation === "status").length, 4);
      assert.equal(yield* Ref.get(f.commits), 2);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect.each(["list", "read"] as const)(
  "keeps ordinary forwarded %s available to a legacy sign-in",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.sql`DELETE FROM agent_approval_authorizations WHERE session_id = 'source-session'`;
      const result = yield* f.call(
        action === "list"
          ? { action, environmentId: EnvironmentId.make("b"), threadId: input.threadId }
          : {
              action,
              environmentId: EnvironmentId.make("b"),
              threadId: input.threadId,
              requestId: input.requestId,
            },
      );
      const view = {
        answerable: { via: "ui_only", reason: "approvals_not_granted" },
        receipts: [],
      };
      assert.deepEqual(result, action === "list" ? { requests: [view] } : view);
      assert.deepEqual(f.readIdentities, [undefined]);
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_approval_forward_operations`, []);
    }).pipe(
      Effect.provide([NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer]),
      Effect.scoped,
    ),
);
