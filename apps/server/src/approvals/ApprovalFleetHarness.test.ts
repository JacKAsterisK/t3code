import * as Cause from "effect/Cause";
import type * as Exit from "effect/Exit";
import * as Statement from "effect/sql/Statement";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type * as Wire from "../../../../packages/contracts/src/approvalForwarding.ts";
import { ApprovalTestHooks } from "./ApprovalTestHooks.ts";
import * as R from "./testkit/ApprovalFleetHarnessReceiver.ts";
import {
  ApprovalGuard,
  ApprovalBinding,
  ApprovalReceiptResult,
  CommandId,
  EventId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Authority from "../auth/ApprovalAuthority.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as PeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as Delegations from "./ApprovalDelegations.ts";
import * as H from "./testkit/ApprovalFleetHarnessEnvironment.ts";
import * as N from "./testkit/ApprovalFleetHarnessNative.ts";
import * as L from "./testkit/ApprovalFleetHarnessLaunch.ts";
import { ThreadId } from "@t3tools/contracts";

const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcError = Schema.decodeUnknownSync(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Number, message: Schema.String }) }),
);
const decodeStoredGuard = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ guard: ApprovalGuard })),
);
const decodeRead = Schema.decodeUnknownEffect(
  Schema.Struct({
    requestId: Schema.String,
    expected: ApprovalBinding,
    grantDigest: Schema.String,
    receipts: Schema.Array(ApprovalReceiptResult),
    answerable: Schema.Struct({ via: Schema.String, reason: Schema.optional(Schema.String) }),
  }),
);
const readApproval = Effect.fn("ApprovalFleetHarness.readApproval")(function* (
  client: H.FleetClient,
  input: N.NativeProbe["input"],
) {
  const response = yield* client.call({
    action: "read",
    environmentId: input.environmentId,
    threadId: input.threadId,
    requestId: input.requestId,
  });
  const result = response.result as { isError?: boolean; structuredContent?: unknown };
  assert.notEqual(result.isError, true, stringify(response));
  return yield* decodeRead(result.structuredContent);
});
const fixture = Effect.fn("ApprovalFleetHarness.fixture")(function* (
  suffix: string,
  linkAccess: "full-access" | "approval-required" = "full-access",
  hooks: { readonly afterForwardReconcile?: Effect.Effect<void> } = {},
) {
  const a = yield* H.makeEnvironment("A");
  const b = yield* H.makeEnvironment("B");
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.sql, b.sql);
  const network = yield* H.makeNetwork();
  const link = yield* H.linkPeer(a, b, linkAccess);
  const sourceUrl = yield* Ref.make("");
  const bs = yield* H.serve(b, H.forwardingLayer({ env: a, url: sourceUrl }, link, network), true);
  const as = yield* H.serve(
    a,
    H.forwardingLayer(bs, link, network).pipe(
      Layer.provide(Layer.succeed(ApprovalTestHooks, hooks)),
    ),
  );
  yield* Ref.set(sourceUrl, as.url);
  const c1 = yield* H.oauthClient(as, `client-one:${suffix}`);
  const c2 = yield* H.oauthClient(as, `client-two:${suffix}`);
  assert.notEqual(c1.initiatingClientId, c2.initiatingClientId);
  const probe = yield* N.startNative(b, suffix, linkAccess);
  const delegations = Context.get(b.context, Delegations.ApprovalDelegations);
  const grant = () =>
    delegations.grant(b.owner.sessionId, {
      threadId: probe.input.threadId,
      linkIdentityId: link.linkIdentityId,
      initiatingClientId: c1.initiatingClientId,
    });
  return { a, b, as, bs, network, link, c1, c2, probe, grant, delegations };
});
const dependencies = Layer.mergeAll(H.baseLayer, N.nativeLayer);
const sourceBoundaryFixture = Effect.fn("ApprovalFleetHarness.sourceBoundaryFixture")(function* (
  suffix: string,
) {
  const a = yield* H.makeEnvironment("A");
  const b = yield* H.makeEnvironment("B");
  const network = yield* H.makeNetwork();
  const link = yield* H.linkPeer(a, b);
  const as = yield* H.serve(a, H.forwardingLayer({ env: b, url: "" }, link, network));
  const c1 = yield* H.oauthClient(as, `boundary-client:${suffix}`);
  const probe = yield* N.startNative(b, suffix);
  return { a, b, as, c1, probe, network };
});

it.live.each([
  ["accept", "full-access"],
  ["decline", "full-access"],
  ["accept", "approval-required"],
  ["decline", "approval-required"],
] as const)(
  "two-environment OAuth MCP forwarding commits %s through %s once and records the actual Node callback",
  ([decision, linkAccess]) =>
    Effect.gen(function* () {
      const f = yield* fixture(`success-${decision}-${linkAccess}`, linkAccess);
      let input = { ...f.probe.input, decision };
      assert.equal(
        yield* H.failureCode(f.c1, {
          ...input,
          clientRequestId: `${input.clientRequestId}:before-delegation`,
        }),
        "thread_not_delegated",
      );
      yield* f.grant();
      const shown = yield* readApproval(f.c1, input);
      assert.equal(shown.answerable.via, "t3_approval_request");
      assert.equal((yield* readApproval(f.c2, input)).answerable.via, "ui_only");
      const unasserted = yield* H.connect(f.bs, f.link.credential.token);
      assert.equal((yield* readApproval(unasserted, input)).answerable.via, "ui_only");
      const listed = yield* f.c1.call({
        action: "list",
        environmentId: input.environmentId,
        threadId: input.threadId,
      });
      assert.include(stringify(listed), '"via":"t3_approval_request"');
      input = {
        ...input,
        expected: shown.expected,
        consent: { ...input.consent, grantDigest: shown.grantDigest },
      };
      const committed = yield* H.receipt(f.c1, input);
      assert.equal(committed.state, "committed");
      assert.isUndefined(committed.deliveryEvidence);
      assert.isString(committed.forwarding.commandId);
      const commandId = committed.forwarding.commandId!;
      yield* H.proof("receipt", {
        environment: "A",
        receiptId: committed.receiptId,
        destinationReceiptId: committed.forwarding.receiptId,
        destinationCommandId: commandId,
        decision,
        state: committed.state,
      });
      const before = yield* f.b.sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`;
      assert.equal(before.length, 1);
      assert.equal(before[0]!.command_id, commandId);
      assert.equal(before[0]!.receipt_id, committed.forwarding.receiptId);
      const guard = decodeStoredGuard(String(before[0]!.operation_json)).guard;
      assert.equal(guard.destination!.authority.basis, "delegation");
      assert.equal(guard.destination!.authority.sourceEnvironmentId, f.a.id);
      assert.equal(guard.destination!.authority.initiatingClientId, f.c1.initiatingClientId);
      assert.equal(guard.destination!.forwarderReceiptId, committed.receiptId);
      assert.include(guard.actor.label, "asserted by");
      assert.equal(guard.destination!.authority.credentialRevision, 1);
      const exact = yield* H.receipt(f.c1, input);
      assert.equal(exact.forwarding.commandId, commandId);
      assert.equal(exact.receiptId, committed.receiptId);
      yield* f.probe.handoff(commandId);
      assert.deepEqual(yield* Fiber.join(f.probe.reply), {
        nativeResponse: {
          permissions: decision === "accept" ? f.probe.nativeRaw.permissions : {},
          scope: "turn",
        },
      });
      const complete = yield* H.receipt(f.c1, H.statusInput(input));
      const audited = yield* readApproval(f.c1, input);
      assert.equal(audited.receipts[0]?.receiptId, committed.forwarding.receiptId);
      assert.equal(audited.receipts[0]?.commandId, commandId);
      assert.equal((yield* readApproval(f.c2, input)).receipts.length, 0);
      assert.equal(complete.state, "response_written");
      assert.equal(complete.deliveryEvidence?.boundary, "node_write_callback");
      assert.equal(complete.forwarding.commandId, commandId);
      const repeated = yield* H.receipt(f.c1, input);
      assert.equal(repeated.state, "response_written");
      assert.equal(repeated.forwarding.commandId, commandId);
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}`)
          .length,
        1,
      );
      yield* H.proof("decision", {
        environment: "B",
        receiptId: complete.forwarding.receiptId,
        commandId,
        decision,
        state: complete.state,
        boundary: complete.deliveryEvidence?.boundary,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["prepare", "commit", "status"] as const)(
  "lost %s reply reconciles the exact A/B operation without another native response",
  (operation) =>
    Effect.gen(function* () {
      const f = yield* fixture(`lost-${operation}`);
      yield* f.grant();
      let firstCommand: string | undefined;
      if (operation === "status")
        firstCommand = (yield* H.receipt(f.c1, f.probe.input)).forwarding.commandId!;
      const barrier = yield* f.network.arm(operation, "after", true);
      const attempt = yield* (
        operation === "status"
          ? H.failureCode(f.c1, H.statusInput(f.probe.input))
          : operation === "prepare"
            ? H.failureCode(f.c1, f.probe.input)
            : H.receipt(f.c1, f.probe.input).pipe(Effect.map((receipt) => receipt.state))
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(barrier.reached);
      const prepared = (yield* f.b
        .sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`)[0]!;
      assert.isDefined(prepared);
      assert.equal(prepared.state, operation === "prepare" ? "prepared" : "committed");
      const commandId = String(prepared.command_id);
      if (firstCommand !== undefined) assert.equal(commandId, firstCommand);
      yield* Deferred.succeed(barrier.release, undefined);
      const first = yield* Fiber.join(attempt);
      assert.equal(first, operation === "commit" ? "delivery_unknown" : "orchestration_error");
      const retry = yield* H.receipt(f.c1, f.probe.input);
      assert.equal(retry.state, "committed");
      assert.equal(retry.forwarding.commandId, commandId);
      assert.equal(retry.forwarding.receiptId, prepared.receipt_id);
      assert.equal(f.network.calls.filter((call) => call.operation === "prepare").length, 1);
      assert.equal(
        f.network.calls.filter((call) => call.operation === "commit" && call.cancel !== true)
          .length,
        1,
      );
      yield* f.probe.handoff(commandId);
      assert.deepEqual(yield* Fiber.join(f.probe.reply), {
        nativeResponse: { permissions: f.probe.nativeRaw.permissions, scope: "turn" },
      });
      const status = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
      assert.equal(status.state, "response_written");
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}`)
          .length,
        1,
      );
      yield* H.proof("boundary", {
        environment: "A/B",
        lostReply: operation,
        commandId,
        state: status.state,
        nativeAnswers: 1,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "same-key conflicts and two initiating clients keep separate receipts and native commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("client-isolation");
      yield* f.grant();
      const first = yield* H.receipt(f.c1, f.probe.input);
      assert.equal(
        yield* H.failureCode(f.c1, { ...f.probe.input, decision: "decline" }),
        "idempotency_conflict",
      );
      const second = yield* N.startNative(f.b, "client-isolation-second");
      yield* f.delegations.grant(f.b.owner.sessionId, {
        threadId: second.input.threadId,
        linkIdentityId: f.link.linkIdentityId,
        initiatingClientId: f.c2.initiatingClientId,
      });
      const input = { ...second.input, clientRequestId: f.probe.input.clientRequestId };
      const other = yield* H.receipt(f.c2, input);
      assert.equal(other.state, "committed");
      assert.notEqual(other.receiptId, first.receiptId);
      assert.notEqual(other.forwarding.commandId, first.forwarding.commandId);
      const forwards = yield* f.a.sql`SELECT * FROM agent_approval_forward_operations`;
      assert.equal(new Set(forwards.map((row) => row.forwarding_key)).size, 2);
      const remote = yield* f.b.sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`;
      assert.equal(remote.length, 2);
      yield* f.probe.handoff(first.forwarding.commandId!);
      yield* second.handoff(other.forwarding.commandId!);
      yield* Fiber.join(f.probe.reply);
      yield* Fiber.join(second.reply);
      yield* H.proof("receipt", {
        environment: "A/B",
        clientRequestId: input.clientRequestId,
        commandIds: [first.forwarding.commandId, other.forwarding.commandId],
        distinctClientPrincipals: true,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live("Full access still refuses a wrong link, wrong client and unrelated operator thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture("exact-delegation");
    yield* f.grant();
    assert.equal(
      yield* H.failureCode(f.c2, { ...f.probe.input, clientRequestId: "wrong-client" }),
      "thread_not_delegated",
    );
    const first = yield* H.receipt(f.c1, f.probe.input);
    const privatePrepare = f.network.calls.find(
      (call) => call.operation === "prepare" && call.initiatingClientId === f.c1.initiatingClientId,
    )!;
    const wrong = yield* H.linkPeer(f.a, f.b);
    const wrongClient = yield* H.connect(f.bs, wrong.credential.token);
    assert.equal(
      yield* H.failureCode(wrongClient, privatePrepare, "t3_link_approval_request"),
      "thread_not_delegated",
    );
    const unrelated = yield* N.startNative(f.b, "unrelated-operator");
    assert.equal(yield* H.failureCode(f.c1, unrelated.input), "thread_not_delegated");
    assert.equal((yield* f.b.sql`SELECT * FROM agent_thread_approval_origins`).length, 0);
    assert.equal(
      (yield* f.b.sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`).length,
      1,
    );
    assert.equal(
      (yield* f.b.projections.getRuntimeResponseContext(
        unrelated.input.threadId,
        unrelated.pending.id,
      )).request?.status,
      "pending",
    );
    yield* f.probe.handoff(first.forwarding.commandId!);
    yield* Fiber.join(f.probe.reply);
    yield* H.proof("decision", {
      environment: "B",
      state: "refused",
      reasons: ["wrong-link", "wrong-client", "unrelated-thread"],
      linkAccess: "full-access",
      authorityBasis: "explicit-owner-delegation",
    });
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["policy", "delegation"] as const)(
  "B %s removal after prepare refuses commit while the retained peer credential still authenticates",
  (removal) =>
    Effect.gen(function* () {
      const f = yield* fixture(`precommit-${removal}`);
      const delegation = yield* f.grant();
      const barrier = yield* f.network.arm("prepare", "after");
      const attempt = yield* H.receipt(f.c1, f.probe.input).pipe(Effect.forkScoped);
      yield* Deferred.await(barrier.reached);
      const prepared = (yield* f.b
        .sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`)[0]!;
      assert.equal(prepared.state, "prepared");
      if (removal === "policy")
        yield* Context.get(f.b.context, PeerAccess.ApprovalPeerAccess).setPolicy(
          f.b.owner.sessionId,
          f.link.linkIdentityId,
          false,
          1,
        );
      else yield* f.delegations.revoke(f.b.owner.sessionId, delegation.delegation_id);
      yield* Deferred.succeed(barrier.release, undefined);
      const result = yield* Fiber.join(attempt);
      assert.equal(result.state, "refused");
      assert.equal(result.forwarding.commandId, prepared.command_id);
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${prepared.command_id}`)
          .length,
        0,
      );
      assert.equal(
        (yield* f.b.projections.getRuntimeResponseContext(
          f.probe.input.threadId,
          f.probe.pending.id,
        )).request?.status,
        "pending",
      );
      assert.equal((yield* H.receipt(f.c1, H.statusInput(f.probe.input))).state, "refused");
      yield* H.proof("boundary", {
        environment: "B",
        removal,
        boundary: "after_prepare_before_commit",
        commandId: prepared.command_id,
        state: result.state,
        nativeWrites: 0,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "B authority removal after commit withholds the real native handoff and recovers a fresh incarnation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("postcommit-authority");
      yield* f.grant();
      const committed = yield* H.receipt(f.c1, f.probe.input);
      assert.equal(committed.state, "committed");
      const authority = Context.get(f.b.context, Authority.ApprovalAuthority);
      yield* authority.remove(f.link.credential.sessionId, false);
      yield* f.probe.handoff(committed.forwarding.commandId!, "delivery_withheld");
      const recovered = yield* f.b.projections.getRuntimeResponseContext(
        f.probe.input.threadId,
        f.probe.pending.id,
      );
      assert.equal(recovered.request?.status, "pending");
      assert.notEqual(
        recovered.request?.approval?.requestIncarnation,
        f.probe.pending.approval?.requestIncarnation,
      );
      assert.isUndefined(f.probe.reply.pollUnsafe());
      const status = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
      assert.equal(status.state, "delivery_withheld");
      assert.equal(status.deliveryEvidence?.boundary, "not_started");
      const retry = yield* H.receipt(f.c1, f.probe.input);
      assert.equal(retry.state, "delivery_withheld");
      assert.equal(retry.forwarding.commandId, committed.forwarding.commandId);
      yield* H.proof("boundary", {
        environment: "B",
        removal: "current-approval-authority",
        boundary: "after_commit_before_admission",
        commandId: committed.forwarding.commandId,
        state: retry.state,
        nativeWrites: 0,
        recoveredIncarnation: recovered.request?.approval?.requestIncarnation,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "A removal while prepare is queued persists cancellation at B before the queued request arrives",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("queued-source-removal");
      yield* f.grant();
      const queued = yield* f.network.arm("prepare", "before");
      const attempt = yield* H.failureCode(f.c1, f.probe.input).pipe(Effect.forkScoped);
      yield* Deferred.await(queued.reached);
      assert.equal((yield* f.b.sql`SELECT * FROM agent_approval_receipts`).length, 0);
      const cancelled = yield* f.network.arm("commit", "after");
      yield* Context.get(f.a.context, Authority.ApprovalAuthority).remove(f.c1.sessionId, false);
      yield* Deferred.await(cancelled.reached);
      assert.equal((yield* f.b.sql`SELECT * FROM agent_approval_receiver_cancellations`).length, 1);
      yield* Deferred.succeed(cancelled.release, undefined);
      yield* Deferred.succeed(queued.release, undefined);
      assert.equal(yield* Fiber.join(attempt), "authority_revoked");
      assert.equal(
        f.network.calls.filter((call) => call.operation === "commit" && call.cancel !== true)
          .length,
        0,
      );
      assert.equal((yield* f.b.sql`SELECT * FROM agent_approval_receipts`).length, 0);
      const source = (yield* f.a.sql`SELECT * FROM agent_approval_receipts`)[0]!;
      assert.equal(source.state, "refused");
      yield* H.proof("boundary", {
        environment: "A/B",
        removal: "source-approval",
        boundary: "queued_prepare",
        state: source.state,
        destinationCancellations: 1,
        nativeWrites: 0,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "retained-token policy revocation and peer rotation preserve the completed operation identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("rotation");
      yield* f.grant();
      const first = yield* H.receipt(f.c1, f.probe.input);
      yield* f.probe.handoff(first.forwarding.commandId!);
      yield* Fiber.join(f.probe.reply);
      const peers = Context.get(f.b.context, PeerAccess.ApprovalPeerAccess);
      const another = yield* N.startNative(f.b, "retained-token-refusal");
      yield* f.delegations.grant(f.b.owner.sessionId, {
        threadId: another.input.threadId,
        linkIdentityId: f.link.linkIdentityId,
        initiatingClientId: f.c1.initiatingClientId,
      });
      yield* peers.setPolicy(f.b.owner.sessionId, f.link.linkIdentityId, false, 1);
      const retained = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
      assert.equal(retained.state, "response_written");
      assert.equal(yield* H.failureCode(f.c1, another.input), "link_not_approved");
      yield* peers.setPolicy(f.b.owner.sessionId, f.link.linkIdentityId, true, 2);
      yield* f.link.rotate();
      const rotated = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
      assert.equal(rotated.forwarding.commandId, first.forwarding.commandId);
      assert.equal(rotated.forwarding.receiptId, first.forwarding.receiptId);
      assert.equal(rotated.receiptId, first.receiptId);
      assert.equal(rotated.state, "response_written");
      assert.equal(
        (yield* H.receipt(f.c1, f.probe.input)).forwarding.commandId,
        first.forwarding.commandId,
      );
      assert.equal(
        (yield* f.b.sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`).length,
        1,
      );
      yield* H.proof("receipt", {
        environment: "A/B",
        receiptId: first.receiptId,
        destinationReceiptId: rotated.forwarding.receiptId,
        commandId: rotated.forwarding.commandId,
        state: rotated.state,
        stableAcross: ["retained-token-policy-removal", "credential-rotation"],
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "approval removal and read-only downgrade retain read/status recovery without fresh commit authority",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("read-recovery");
      yield* f.grant();
      const first = yield* H.receipt(f.c1, f.probe.input);
      yield* f.probe.handoff(first.forwarding.commandId!);
      yield* Fiber.join(f.probe.reply);
      yield* Context.get(f.a.context, Authority.ApprovalAuthority).remove(f.c1.sessionId, false);
      yield* f.a
        .sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${f.c1.sessionId}`;
      yield* f.b
        .sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${f.link.credential.sessionId}`;
      const read = yield* f.c1.call({
        action: "read",
        environmentId: f.b.id,
        threadId: f.probe.input.threadId,
        requestId: f.probe.pending.id,
      });
      assert.notInclude(stringify(read), '"isError":true');
      const audited = yield* readApproval(f.c1, f.probe.input);
      assert.equal(audited.answerable.via, "ui_only");
      assert.equal(audited.receipts[0]?.receiptId, first.forwarding.receiptId);
      assert.equal(audited.receipts[0]?.state, "response_written");
      const status = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
      assert.equal(status.state, "response_written");
      assert.equal(status.forwarding.commandId, first.forwarding.commandId);
      assert.equal(yield* H.failureCode(f.c1, f.probe.input), "approvals_not_granted");
      yield* H.proof("boundary", {
        environment: "A/B",
        boundary: "approval_removed_and_read_only",
        commandId: status.forwarding.commandId,
        read: "permitted",
        status: status.state,
        respond: "refused",
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "public MCP rejects forged attestation and native guards and never exposes link-only authority",
  () =>
    Effect.gen(function* () {
      const f = yield* sourceBoundaryFixture("public-forgery");
      const noOptIn = yield* H.oauthClient(
        f.as,
        "Full access without approval",
        "full-access",
        false,
      );
      assert.equal(yield* H.failureCode(noOptIn, f.probe.input), "approvals_not_granted");
      for (const forged of [
        { attestation: { owner: "Dan", initiatingClientId: f.c1.initiatingClientId } },
        { approvalGuard: { authorityRevision: 1, sessionId: f.b.owner.sessionId } },
      ]) {
        const response = yield* f.c1.call({ ...f.probe.input, ...forged });
        assert.equal(decodeRpcError(response).error.code, -32602);
      }
      assert.equal(f.network.calls.length, 0);
      assert.equal((yield* f.a.sql`SELECT * FROM agent_approval_receipts`).length, 0);
      assert.equal((yield* f.b.sql`SELECT * FROM agent_approval_receipts`).length, 0);
      const fakeWire = {
        operation: "status",
        clientRequestId: "forged",
        initiatingClientId: f.c1.initiatingClientId,
        forwarderReceiptId: "forged",
        operationDigest: "forged",
      };
      const hidden = decodeRpcError(yield* f.c1.call(fakeWire, "t3_link_approval_request"));
      assert.equal(hidden.error.code, -32602);
      assert.include(hidden.error.message, "t3_link_approval_request");
      yield* H.proof("decision", {
        environment: "A/B",
        state: "refused",
        fields: ["attestation", "approvalGuard"],
        authenticatedLocalClientCannotBePeer: true,
        nativeWrites: 0,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "every remote-chain public action refuses a Full access linked caller before sending another MCP request",
  () =>
    Effect.gen(function* () {
      const f = yield* sourceBoundaryFixture("no-chaining");
      const incoming = yield* H.linkPeer(f.b, f.a);
      const linked = yield* H.connect(f.as, incoming.credential.token);
      const remote = { environmentId: f.b.id, threadId: f.probe.input.threadId };
      const before = f.network.calls.length;
      for (const input of [
        { action: "list", ...remote },
        { action: "read", ...remote, requestId: f.probe.pending.id },
        { action: "status", ...remote, clientRequestId: "chain-key" },
        { ...f.probe.input, ...remote },
      ])
        assert.equal(yield* H.failureCode(linked, input), "forwarding_chain_refused");
      assert.equal(f.network.calls.length, before);
      assert.equal((yield* f.a.sql`SELECT * FROM agent_approval_receipts`).length, 0);
      assert.equal((yield* f.b.sql`SELECT * FROM agent_approval_receipts`).length, 0);
      yield* H.proof("decision", {
        environment: "B",
        state: "refused",
        actions: ["list", "read", "status", "respond"],
        reason: "linked-caller-remote-chain",
        linkAccess: "full-access",
        forwardedCalls: 0,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["incarnation", "presentation"] as const)(
  "a native request %s change projected after B prepare prevents commitment and any write",
  (change) =>
    Effect.gen(function* () {
      const f = yield* fixture(`native-${change}`);
      yield* f.grant();
      const barrier = yield* f.network.arm("prepare", "after");
      const attempt = yield* H.receipt(f.c1, f.probe.input).pipe(Effect.forkScoped);
      yield* Deferred.await(barrier.reached);
      const current = yield* f.b.projections.getRuntimeResponseContext(
        f.probe.input.threadId,
        f.probe.pending.id,
      );
      const descriptor = current.request!.approval!;
      const changed =
        change === "incarnation"
          ? { ...descriptor, requestIncarnation: `${descriptor.requestIncarnation}:reconnected` }
          : { ...descriptor, presentationRevision: descriptor.presentationRevision + 1 };
      const common = { threadId: f.probe.input.threadId, occurredAt: yield* DateTime.now };
      yield* f.b.projections.apply({
        ...common,
        id: EventId.make(`fleet-change-request:${change}`),
        type: "runtime-request.updated",
        payload: { ...current.request!, approval: changed },
      });
      assert.equal(current.item?.type, "approval_request");
      if (current.item?.type !== "approval_request")
        return assert.fail("Expected actual native approval presentation");
      yield* f.b.projections.apply({
        ...common,
        id: EventId.make(`fleet-change-item:${change}`),
        type: "turn-item.updated",
        payload: { ...current.item, approval: changed },
      });
      yield* Deferred.succeed(barrier.release, undefined);
      const result = yield* Fiber.join(attempt);
      assert.equal(result.state, "refused");
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${result.forwarding.commandId}`)
          .length,
        0,
      );
      assert.isUndefined(f.probe.reply.pollUnsafe());
      yield* H.proof("boundary", {
        environment: "B",
        change,
        boundary: "after_prepare_before_commit",
        state: result.state,
        nativeWrites: 0,
        stimulus: "projection-event-on-real-native-request",
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const assertTypedRefusal = (exit: Exit.Exit<Wire.LinkApprovalResult, unknown>, code: string) => {
  if (exit._tag === "Failure") {
    assert.isFalse(
      Cause.hasDies(exit.cause),
      "The receiver must not defect during a cancellation race",
    );
    const failure = Cause.findError(exit.cause);
    if (failure._tag !== "Success" || !isMcpFailure(failure.success))
      return assert.fail("Expected a typed receiver refusal");
    assert.equal(failure.success.code, code);
    return;
  }
  assert.equal(exit.value.receipt?.state, "refused");
  assert.equal(exit.value.receipt!.failureCode, code);
};

it.live("actual B cancellation racing commitment is a typed refusal without a native defect", () =>
  Effect.gen(function* () {
    const f = yield* R.receiverFixture("receiver-cancel-commit");
    const prepared = (yield* f.receive(f.prepare)).receipt!;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const committing = yield* f.receive(f.commit).pipe(
      Effect.provideService(ApprovalTestHooks, {
        afterPrepare: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      }),
      Effect.exit,
      Effect.forkScoped,
    );
    yield* Deferred.await(reached);
    const cancelled = yield* f.receive(f.cancel);
    assert.equal(cancelled.receipt?.state, "refused");
    yield* Deferred.succeed(release, undefined);
    const outcome = yield* Fiber.join(committing);
    yield* H.proof("boundary", {
      environment: "B",
      boundary: "cancel_racing_commit",
      outcome: outcome._tag,
      nativeDefect: outcome._tag === "Failure" && Cause.hasDies(outcome.cause),
      nativeDefectMessage:
        outcome._tag === "Failure" ? String(Cause.findDefect(outcome.cause)) : null,
    });
    assertTypedRefusal(outcome, "authority_revoked");
    const final = (yield* f.receive(f.status)).receipt!;
    assert.equal(final.commandId, prepared.commandId);
    assert.equal(final.state, "refused");
    assert.equal(
      (yield* f.b
        .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${prepared.commandId}`)
        .length,
      0,
    );
    assert.equal(
      (yield* f.b.projections.getRuntimeResponseContext(f.probe.input.threadId, f.probe.pending.id))
        .request?.status,
      "pending",
    );
    yield* H.proof("boundary", {
      environment: "B",
      boundary: "cancel_after_commit_precheck_before_native_dispatch",
      state: final.state,
      commandId: final.commandId,
      typedRefusal: true,
      nativeWrites: 0,
    });
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["prepare-in-flight", "cancel-in-flight"] as const)(
  "actual B %s observes the cancellation tombstone and cannot leave a committable prepared receipt",
  (race) =>
    Effect.gen(function* () {
      const f = yield* R.receiverFixture(`receiver-tombstone-${race}`);
      const barrier = yield* R.sqlBarrier("FROM agent_approval_receiver_cancellations", f.b.sql);
      const paused = yield* f
        .receive(race === "prepare-in-flight" ? f.prepare : f.cancel)
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, barrier.transformer),
          Effect.exit,
          Effect.forkScoped,
        );
      const heldTransaction = yield* Deferred.await(barrier.reached);
      if (heldTransaction) {
        const concurrent = yield* f
          .receive(race === "prepare-in-flight" ? f.cancel : f.prepare)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.succeed(barrier.release, undefined);
        const completed = yield* Fiber.join(paused);
        const competing = yield* Fiber.join(concurrent);
        assertTypedRefusal(competing, "authority_revoked");
        assert.equal(completed._tag, "Success");
      } else {
        const concurrent = yield* f.receive(race === "prepare-in-flight" ? f.cancel : f.prepare);
        if (race === "cancel-in-flight") assert.equal(concurrent.receipt?.state, "prepared");
        yield* Deferred.succeed(barrier.release, undefined);
        const completed = yield* Fiber.join(paused);
        const observed = yield* f.receive(f.status);
        yield* H.proof("receipt", {
          environment: "B",
          boundary: race,
          state: observed.receipt?.state ?? "absent",
          receiptId: observed.receipt?.receiptId ?? null,
          cancelReplyState:
            completed._tag === "Success"
              ? (completed.value.receipt?.state ?? "absent")
              : "typed-failure",
        });
        if (race === "prepare-in-flight") assertTypedRefusal(completed, "authority_revoked");
        else {
          assert.equal(completed._tag, "Success");
          if (completed._tag === "Success") assert.equal(completed.value.receipt?.state, "refused");
        }
      }
      const status = yield* f.receive(f.status);
      if (status.receipt !== null) assert.equal(status.receipt.state, "refused");
      assertTypedRefusal(yield* f.receive(f.commit).pipe(Effect.exit), "authority_revoked");
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE effect_type = 'runtime-request.respond'`)
          .length,
        0,
      );
      assert.isUndefined(f.probe.reply.pollUnsafe());
      yield* H.proof("boundary", {
        environment: "B",
        boundary: race,
        state: "cancelled",
        receiptId: status.receipt?.receiptId ?? null,
        nativeWrites: 0,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live(
  "actual B transient receiver storage failure leaves the same prepared operation recoverable",
  () =>
    Effect.gen(function* () {
      const f = yield* R.receiverFixture("receiver-transient-storage");
      const prepared = (yield* f.receive(f.prepare)).receipt!;
      yield* f.b
        .sql`ALTER TABLE agent_thread_approval_origins RENAME TO fixture_unavailable_origins`;
      const failed = yield* f
        .receive(f.commit)
        .pipe(
          Effect.exit,
          Effect.ensuring(
            f.b
              .sql`ALTER TABLE fixture_unavailable_origins RENAME TO agent_thread_approval_origins`.pipe(
              Effect.orDie,
            ),
          ),
        );
      assertTypedRefusal(failed, "orchestration_error");
      const recoverable = (yield* f.receive(f.status)).receipt!;
      yield* H.proof("receipt", {
        environment: "B",
        boundary: "transient_storage_failure",
        receiptId: recoverable.receiptId,
        commandId: recoverable.commandId,
        state: recoverable.state,
        failureCode: recoverable.failureCode,
      });
      assert.equal(
        recoverable.state,
        "prepared",
        "A transient storage error must not be persisted as authority revocation",
      );
      assert.equal(recoverable.commandId, prepared.commandId);
      const committed = (yield* f.receive(f.commit)).receipt!;
      assert.equal(committed.state, "committed");
      assert.equal(committed.commandId, prepared.commandId);
      assert.equal(committed.receiptId, prepared.receiptId);
      yield* f.probe.handoff(committed.commandId);
      yield* Fiber.join(f.probe.reply);
      const complete = (yield* f.receive(f.status)).receipt!;
      assert.equal(complete.state, "response_written");
      yield* H.proof("receipt", {
        environment: "B",
        receiptId: complete.receiptId,
        commandId: complete.commandId,
        state: complete.state,
        recoveredFrom: "transient_SQLite_read_failure",
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["before-commit", "before-admission"] as const)(
  "actual B mode-ceiling change %s records mode_changed instead of authority_revoked",
  (boundary) =>
    Effect.gen(function* () {
      const f = yield* R.receiverFixture(`receiver-mode-${boundary}`);
      const prepared = (yield* f.receive(f.prepare)).receipt!;
      if (boundary === "before-admission")
        assert.equal((yield* f.receive(f.commit)).receipt?.state, "committed");
      yield* f.b
        .sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'approval-required' WHERE session_id = ${f.link.credential.sessionId}`;
      if (boundary === "before-commit") {
        const outcome = yield* f.receive(f.commit).pipe(Effect.exit);
        const observed = (yield* f.receive(f.status)).receipt!;
        yield* H.proof("receipt", {
          environment: "B",
          boundary: "mode_before_commit",
          commandId: observed.commandId,
          state: observed.state,
          failureCode: observed.failureCode,
        });
        assertTypedRefusal(outcome, "mode_changed");
      } else yield* f.probe.handoff(prepared.commandId, "delivery_withheld");
      const final = (yield* f.receive(f.status)).receipt!;
      assert.equal(final.failureCode, "mode_changed");
      assert.equal(final.commandId, prepared.commandId);
      assert.isUndefined(f.probe.reply.pollUnsafe());
      yield* H.proof("boundary", {
        environment: "B",
        boundary,
        commandId: final.commandId,
        state: final.state,
        failureCode: final.failureCode,
        nativeWrites: 0,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["before-commit", "after-commit-before-admission"] as const)(
  "actual B authorized stable-link renewal %s preserves the original operation and native command",
  (boundary) =>
    Effect.gen(function* () {
      const f = yield* R.receiverFixture(`receiver-renewal-${boundary}`);
      const prepared = (yield* f.receive(f.prepare)).receipt!;
      if (boundary === "after-commit-before-admission")
        assert.equal((yield* f.receive(f.commit)).receipt?.state, "committed");
      const renewed = yield* f.link.rotate();
      assert.notEqual(renewed.sessionId, f.link.credential.sessionId);
      const status = (yield* f.receive(f.status)).receipt!;
      assert.equal(status.commandId, prepared.commandId);
      assert.equal(status.receiptId, prepared.receiptId);
      if (boundary === "before-commit") {
        const observed = (yield* f.receive(f.commit)).receipt!;
        yield* H.proof("receipt", {
          environment: "B",
          boundary: "renewal_before_commit",
          commandId: observed.commandId,
          receiptId: observed.receiptId,
          state: observed.state,
          failureCode: observed.failureCode,
        });
        assert.equal(observed.state, "committed");
      }
      yield* f.probe.handoff(prepared.commandId);
      assert.deepEqual(yield* Fiber.join(f.probe.reply), {
        nativeResponse: { permissions: f.probe.nativeRaw.permissions, scope: "turn" },
      });
      const final = (yield* f.receive(f.status)).receipt!;
      assert.equal(final.state, "response_written");
      assert.equal(final.commandId, prepared.commandId);
      assert.equal(final.receiptId, prepared.receiptId);
      assert.equal(
        (yield* f.b.sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`).length,
        1,
      );
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${prepared.commandId}`)
          .length,
        1,
      );
      yield* H.proof("receipt", {
        environment: "B",
        boundary,
        receiptId: final.receiptId,
        commandId: final.commandId,
        linkIdentityId: f.link.linkIdentityId,
        state: final.state,
        stableAcross: "authorized_peer_credential_renewal",
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["approval-required", "full-access"] as const)(
  "authenticated A client launch through %s persists B origin and authorizes only that initiating client",
  (access) =>
    Effect.gen(function* () {
      const a = yield* H.makeEnvironment("A");
      const b = yield* H.makeEnvironment("B");
      const sourceFailure = yield* Ref.make(false);
      const destinationFailure = yield* Ref.make(false);
      const originalAuthority = Context.get(a.context, Authority.ApprovalAuthority);
      const originalDelegations = Context.get(b.context, Delegations.ApprovalDelegations);
      const source = {
        ...a,
        context: Context.add(a.context, Authority.ApprovalAuthority, {
          ...originalAuthority,
          identity: Effect.fn("ApprovalFleetHarness.sourceIdentity")(function* (
            ...args: Parameters<typeof originalAuthority.identity>
          ) {
            if (!(yield* Ref.getAndSet(sourceFailure, false)))
              return yield* originalAuthority.identity(...args);
            yield* a.sql`ALTER TABLE agent_approval_authorizations RENAME TO fixture_unavailable_authorizations`.pipe(
              Effect.orDie,
            );
            return yield* originalAuthority
              .identity(...args)
              .pipe(
                Effect.ensuring(
                  a.sql`ALTER TABLE fixture_unavailable_authorizations RENAME TO agent_approval_authorizations`.pipe(
                    Effect.orDie,
                  ),
                ),
              );
          }),
        }),
      };
      const destination = {
        ...b,
        context: Context.add(b.context, Delegations.ApprovalDelegations, {
          ...originalDelegations,
          authenticate: Effect.fn("ApprovalFleetHarness.destinationIdentity")(function* (
            id: string,
          ) {
            if (!(yield* Ref.getAndSet(destinationFailure, false)))
              return yield* originalDelegations.authenticate(id);
            yield* b.sql`ALTER TABLE agent_approval_destination_links RENAME TO fixture_unavailable_links`.pipe(
              Effect.orDie,
            );
            return yield* originalDelegations
              .authenticate(id)
              .pipe(
                Effect.ensuring(
                  b.sql`ALTER TABLE fixture_unavailable_links RENAME TO agent_approval_destination_links`.pipe(
                    Effect.orDie,
                  ),
                ),
              );
          }),
        }),
      };
      const network = yield* H.makeNetwork();
      const link = yield* H.linkPeer(a, b, access);
      const sourceUrl = yield* Ref.make("");
      const bs = yield* H.serve(
        destination,
        H.forwardingLayer({ env: a, url: sourceUrl }, link, network),
        true,
        true,
      );
      const as = yield* H.serve(source, H.forwardingLayer(bs, link, network), false, true);
      yield* Ref.set(sourceUrl, as.url);
      const client = yield* H.oauthClient(as, `launch-client:${access}`);
      const other = yield* H.oauthClient(as, `other-launch-client:${access}`);
      const launchInput = {
        environmentId: b.id,
        projectId: L.projectId,
        title: "Authenticated launch",
        modelSelection: { instanceId: H.instanceId, model: "gpt-5.4" },
        runtimeMode: access,
        interactionMode: "default",
        clientRequestId: `creation-provenance:${access}`,
        initiatingClientId: other.initiatingClientId,
      };
      const beforeA = yield* a.sql`SELECT thread_id FROM orchestration_v2_projection_threads`;
      const beforeB = yield* b.sql`SELECT thread_id FROM orchestration_v2_projection_threads`;
      const beforeProjects = yield* b.sql`SELECT project_id FROM projection_projects`;
      for (const fault of [sourceFailure, destinationFailure]) {
        yield* Ref.set(fault, true);
        assert.equal(
          yield* H.failureCode(client, launchInput, "t3_thread_launch"),
          "orchestration_error",
        );
        assert.deepEqual(
          yield* a.sql`SELECT thread_id FROM orchestration_v2_projection_threads`,
          beforeA,
        );
        assert.deepEqual(
          yield* b.sql`SELECT thread_id FROM orchestration_v2_projection_threads`,
          beforeB,
        );
        assert.deepEqual(yield* b.sql`SELECT project_id FROM projection_projects`, beforeProjects);
        assert.equal((yield* b.sql`SELECT * FROM agent_thread_approval_origins`).length, 0);
        assert.equal(
          (yield* b.sql`SELECT * FROM orchestration_events WHERE event_type = 'thread.created'`)
            .length,
          0,
        );
      }
      const launched = yield* client.call(launchInput, "t3_thread_launch");
      const structured = launched.result as {
        isError?: boolean;
        structuredContent?: { threadId: string };
      };
      assert.notEqual(structured.isError, true, stringify(launched));
      assert.isString(structured.structuredContent?.threadId);
      const threadId = ThreadId.make(structured.structuredContent!.threadId);
      const origins =
        yield* b.sql`SELECT * FROM agent_thread_approval_origins WHERE thread_id = ${threadId}`;
      assert.equal(origins.length, 1);
      assert.equal(origins[0]!.source_environment_id, a.id);
      assert.equal(origins[0]!.link_identity_id, link.linkIdentityId);
      assert.equal(origins[0]!.initiating_client_id, client.initiatingClientId);
      assert.equal((yield* b.sql`SELECT * FROM agent_approval_delegations`).length, 0);
      const probe = yield* N.startNative(b, `link-created:${access}`, access, threadId);
      assert.equal(
        yield* H.failureCode(other, { ...probe.input, clientRequestId: "wrong-initiating-client" }),
        "thread_not_delegated",
      );
      const shown = yield* readApproval(client, probe.input);
      assert.equal(shown.answerable.via, "t3_approval_request");
      assert.equal((yield* readApproval(other, probe.input)).answerable.via, "ui_only");
      const input = {
        ...probe.input,
        expected: shown.expected,
        consent: { ...probe.input.consent, grantDigest: shown.grantDigest },
      };
      const committed = yield* H.receipt(client, input);
      assert.equal(committed.state, "committed");
      const receiver =
        (yield* b.sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`)[0]!;
      const guard = decodeStoredGuard(String(receiver.operation_json)).guard;
      assert.equal(guard.destination!.authority.basis, "origin");
      yield* probe.handoff(committed.forwarding.commandId!);
      assert.deepEqual(yield* Fiber.join(probe.reply), {
        nativeResponse: { permissions: probe.nativeRaw.permissions, scope: "turn" },
      });
      const status = yield* H.receipt(client, H.statusInput(probe.input));
      assert.equal(status.state, "response_written");
      assert.equal(
        (yield* readApproval(client, input)).receipts[0]?.commandId,
        committed.forwarding.commandId,
      );
      assert.equal((yield* readApproval(other, input)).receipts.length, 0);
      const replay = yield* client.call(launchInput, "t3_thread_launch");
      assert.equal(
        (replay.result as { structuredContent?: { threadId: string } }).structuredContent?.threadId,
        threadId,
      );
      assert.deepEqual(
        yield* b.sql`SELECT * FROM agent_thread_approval_origins WHERE thread_id = ${threadId}`,
        origins,
      );
      yield* H.proof("boundary", {
        environment: "A/B",
        boundary: "actual_client_launch_and_approval",
        access,
        threadId,
        initiatingClientId: client.initiatingClientId,
        linkIdentityId: link.linkIdentityId,
        originSequence: origins[0]!.created_sequence,
        authorityBasis: "origin",
        explicitDelegations: 0,
        ignoredForgedPublicClientId: other.initiatingClientId,
        nativeCommandId: committed.forwarding.commandId,
        state: status.state,
        boundaryEvidence: status.deliveryEvidence?.boundary,
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live.each(["ui", "incarnation"] as const)(
  "actual B status retires a prepared operation after %s changes the unanswered request",
  (change) =>
    Effect.gen(function* () {
      const f = yield* R.receiverFixture(`receiver-stale-status:${change}`);
      const prepared = (yield* f.receive(f.prepare)).receipt!;
      if (change === "ui")
        yield* f.probe.native.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("ui-wins-before-status"),
          threadId: f.probe.input.threadId,
          requestId: f.probe.input.requestId,
          decision: "decline",
        });
      else
        yield* f.b.projections.apply({
          id: EventId.make("changed-before-status"),
          type: "runtime-request.updated",
          threadId: f.probe.input.threadId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...f.probe.pending,
            approval: {
              ...f.probe.pending.approval!,
              requestIncarnation: "replacement-incarnation",
            },
          },
        });
      const status = (yield* f.receive(f.status)).receipt!;
      assert.equal(status.state, "refused");
      assert.equal(status.failureCode, change === "ui" ? "already_answered" : "request_changed");
      assert.equal(status.commandId, prepared.commandId);
      assert.equal((yield* f.receive(f.commit)).receipt?.state, "refused");
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${prepared.commandId}`)
          .length,
        0,
      );
      assert.isUndefined(f.probe.reply.pollUnsafe());
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.live("actual A background recovery retries one stable commit that never reached B", () =>
  Effect.gen(function* () {
    const recovered = yield* Deferred.make<void>();
    let source: H.FleetEnvironment | undefined;
    const f = yield* fixture("unsent-commit-recovery", "full-access", {
      afterForwardReconcile: Effect.gen(function* () {
        if (source === undefined) return;
        const rows =
          yield* source.sql`SELECT receipt_id FROM agent_approval_receipts WHERE role = 'forwarder' AND state = 'committed'`;
        if (rows.length === 1) yield* Deferred.succeed(recovered, undefined);
      }).pipe(Effect.orDie),
    });
    source = f.a;
    yield* f.grant();
    const withheld = yield* f.network.arm("commit", "before", true);
    const pending = yield* H.receipt(f.c1, f.probe.input).pipe(Effect.forkScoped);
    yield* Deferred.await(withheld.reached);
    const prepared = (yield* f.b
      .sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`)[0]!;
    assert.equal(prepared.state, "prepared");
    yield* Deferred.succeed(withheld.release, undefined);
    const unknown = yield* Fiber.join(pending);
    assert.equal(unknown.state, "delivery_unknown");
    yield* f.a.sql`UPDATE agent_approval_forward_operations SET next_reconcile_at = 0`;
    yield* Context.get(f.a.context, Sessions.SessionStore).notifyScopeChange(f.c1.sessionId);
    yield* Deferred.await(recovered);
    const commits = f.network.calls.filter(
      (call) => call.operation === "commit" && call.cancel !== true,
    );
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], commits[1]);
    assert.equal(
      (yield* f.b
        .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${String(prepared.command_id)}`)
        .length,
      1,
    );
    yield* f.probe.handoff(String(prepared.command_id));
    yield* Fiber.join(f.probe.reply);
    const complete = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
    assert.equal(complete.state, "response_written");
    assert.equal(complete.forwarding.commandId, prepared.command_id);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);
it.live(
  "actual forgotten link principal after A admission cannot claim B's native response was stopped",
  () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      let source: H.FleetEnvironment | undefined;
      const f = yield* fixture("forgotten-after-admission", "full-access", {
        afterForwardReconcile: Effect.gen(function* () {
          if (source === undefined) return;
          const rows =
            yield* source.sql`SELECT receipt_id FROM agent_approval_forward_operations WHERE cancelled = 1 AND reconcile_done = 1`;
          if (rows.length === 1) yield* Deferred.succeed(cancelled, undefined);
        }).pipe(Effect.orDie),
      });
      source = f.a;
      yield* f.grant();
      const lost = yield* f.network.arm("commit", "after", true);
      const pending = yield* H.receipt(f.c1, f.probe.input).pipe(Effect.forkScoped);
      yield* Deferred.await(lost.reached);
      const native = (yield* f.b
        .sql`SELECT * FROM agent_approval_receipts WHERE role = 'receiver'`)[0]!;
      yield* f.probe.handoff(String(native.command_id));
      yield* Fiber.join(f.probe.reply);
      const replacement = yield* H.linkPeer(f.a, f.b);
      yield* Ref.set(f.link.token, replacement.credential.token);
      yield* Context.get(f.a.context, Authority.ApprovalAuthority).remove(f.c1.sessionId, false);
      yield* Deferred.await(cancelled);
      yield* Deferred.succeed(lost.release, undefined);
      assert.equal((yield* Fiber.join(pending)).state, "delivery_unknown");
      const status = yield* H.receipt(f.c1, H.statusInput(f.probe.input));
      assert.equal(status.state, "delivery_unknown");
      assert.isUndefined(status.failureCode);
      assert.equal(
        (yield* f.b
          .sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${String(native.command_id)}`)
          .length,
        1,
      );
      assert.equal(
        f.network.calls.filter((call) => call.operation === "commit" && call.cancel !== true)
          .length,
        1,
      );
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
