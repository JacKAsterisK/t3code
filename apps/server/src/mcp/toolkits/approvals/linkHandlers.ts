import {
  LinkApprovalRequest,
  type LinkApprovalWireInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Receiver from "../../../approvals/ApprovalReceiver.ts";
import * as Access from "../../McpToolAccess.ts";
import { LinkApprovalToolkit } from "./linkTools.ts";

const decodeRequest = Schema.decodeUnknownEffect(LinkApprovalRequest);

export const layer = Access.toLayer(
  LinkApprovalToolkit,
  Effect.gen(function* () {
    const receiver = yield* Effect.serviceOption(Receiver.ApprovalReceiver);
    const call = Effect.fn("mcp.linkApprovalRequest")(function* (input: LinkApprovalWireInput) {
      const request = yield* decodeRequest(input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Invalid linked approval operation.",
            }),
        ),
      );
      if (Option.isNone(receiver))
        return yield* new OrchestratorMcpFailure({
          code: "forwarding_unavailable",
          message: "Linked approval delivery is unavailable on this destination.",
        });
      return yield* receiver.value.receive(request);
    });
    return {
      t3_link_approval_request: Access.either(
        (input) =>
          input.operation === "status" || (input.operation === "commit" && input.cancel === true),
        Access.reads(call),
        Access.writes(call, { linkedCallers: "allowed" }),
      ),
    };
  }),
);
