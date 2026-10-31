import { assert } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";
import type * as SqlClient from "effect/sql/SqlClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { approvalOperationDigest } from "@t3tools/shared/approvalPresentation";
import * as Authority from "../../auth/ApprovalAuthority.ts";
import * as Sessions from "../../auth/SessionStore.ts";
import * as OAuth from "../../auth/McpOAuth.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Mcp from "../../mcp/McpHttpServer.ts";
import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as Settings from "../../serverSettings.ts";
import * as Delegations from "../ApprovalDelegations.ts";
import * as Receiver from "../ApprovalReceiver.ts";
import * as Wire from "../../../../../packages/contracts/src/approvalForwarding.ts";
import * as H from "./ApprovalFleetHarnessEnvironment.ts";
import * as N from "./ApprovalFleetHarnessNative.ts";

const encodeWire = Schema.encodeSync(Schema.fromJsonString(Wire.LinkApprovalRequest));
const decodeWire = Schema.decodeUnknownEffect(Schema.fromJsonString(Wire.LinkApprovalRequest));

export const receiverFixture = Effect.fn("ApprovalFleetHarness.receiverFixture")(function* (
  suffix: string,
) {
  const a = yield* H.makeEnvironment("A");
  const b = yield* H.makeEnvironment("B");
  const sessions = Context.get(a.context, Sessions.SessionStore);
  const grantor = (yield* sessions.listActive()).find(
    (session) => session.sessionId === a.owner.sessionId,
  )!;
  const client = yield* a.auth.issueMcpClientSession({
    label: "Authenticated receiver fixture initiator",
    access: "full-access",
    approvals: true,
    peerLink: false,
    applicationId: `receiver-fixture:${suffix}`,
    approvalSubject: grantor.subject,
    client: { deviceType: "bot" },
  });
  const initiating = yield* Context.get(a.context, Authority.ApprovalAuthority).identity(
    client.sessionId,
  );
  const link = yield* H.linkPeer(a, b);
  const probe = yield* N.startNative(b, suffix);
  const delegation = yield* Context.get(b.context, Delegations.ApprovalDelegations).grant(
    b.owner.sessionId,
    {
      threadId: probe.input.threadId,
      linkIdentityId: link.linkIdentityId,
      initiatingClientId: initiating.initiating_client_id,
    },
  );
  const identity = Layer.succeed(
    Environment.ServerEnvironment,
    Environment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(b.id),
      getDescriptor: Effect.die("Receiver authentication does not read environment metadata"),
    }),
  );
  const authContext = yield* Layer.build(
    OAuth.layerMcpClientAuthenticator.pipe(Layer.provide(identity)),
  ).pipe(Effect.provide(b.context));
  const authenticator = Context.get(authContext, Mcp.McpClientAuthenticator);
  const receiverContext = yield* Layer.build(Receiver.layer).pipe(Effect.provide(b.context));
  const receiver = Context.get(receiverContext, Receiver.ApprovalReceiver);
  const forwardingKey = `fixture-forward:${yield* (yield* Crypto.Crypto).randomUUIDv4()}`;
  const forwarderReceiptId = `fixture-forwarder:${yield* (yield* Crypto.Crypto).randomUUIDv4()}`;
  const { environmentId: _destination, ...local } = probe.input;
  const proposal: Wire.ApprovalForwardOperation = {
    version: 1,
    sourceEnvironmentId: a.id,
    initiatingClientId: initiating.initiating_client_id,
    initiatingClientLabel: "Authenticated fixture client (asserted by A)",
    forwarderReceiptId,
    input: { ...local, clientRequestId: forwardingKey },
    limits: { runtimeMode: "full-access", interactionMode: "default" },
  };
  const reference = {
    clientRequestId: forwardingKey,
    initiatingClientId: initiating.initiating_client_id,
    forwarderReceiptId,
    operationDigest: yield* approvalOperationDigest(proposal),
  };
  const prepare: Wire.LinkApprovalRequest = { operation: "prepare", ...reference, proposal };
  const commit: Wire.LinkApprovalRequest = { operation: "commit", ...reference };
  const cancel: Wire.LinkApprovalRequest = { ...commit, cancel: true };
  const status: Wire.LinkApprovalRequest = { operation: "status", ...reference };
  const receive = Effect.fn("ApprovalFleetHarness.authenticatedReceiverCall")(function* (
    input: Wire.LinkApprovalRequest,
  ) {
    const token = yield* Ref.get(link.token);
    const request = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/mcp", { headers: { authorization: `Bearer ${token}` } }),
    );
    const scope = yield* authenticator.authenticate(request);
    assert.isDefined(scope);
    assert.equal(scope!.client?.linked, true);
    const linkedEnvironments = (yield* Context.get(b.context, Settings.ServerSettingsService)
      .getSettings).linkedEnvironmentsEnabled;
    return yield* receiver
      .receive(yield* decodeWire(encodeWire(input)))
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, { ...scope!, linkedEnvironments }),
      );
  });
  yield* H.proof("boundary", {
    environment: "B",
    scenario: suffix,
    transport: "authenticated-receiver-service",
    sourceEnvironmentId: a.id,
    initiatingClientId: initiating.initiating_client_id,
    linkIdentityId: link.linkIdentityId,
    delegationId: delegation.delegation_id,
    automaticCreationProvenance: false,
  });
  return { a, b, probe, link, delegation, receive, prepare, commit, cancel, status };
});

export const sqlBarrier = Effect.fn("ApprovalFleetHarness.sqlBarrier")(function* (
  fragment: string,
  sql: SqlClient.SqlClient,
) {
  const reached = yield* Deferred.make<boolean>();
  const release = yield* Deferred.make<void>();
  let armed = true;
  const transformer: Statement.Transformer = Effect.fn("ApprovalFleetHarness.sqlBarrierStatement")(
    function* (statement: Statement.Statement<unknown>) {
      if (armed && statement.compile()[0].includes(fragment)) {
        armed = false;
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        yield* Deferred.succeed(reached, transaction._tag === "Some");
        yield* Deferred.await(release);
      }
      return statement;
    },
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));
  return { reached, release, transformer };
});
