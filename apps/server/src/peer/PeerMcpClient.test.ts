import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const peer = EnvironmentId.make("peer-environment");
const Answer = Schema.Struct({ ok: Schema.Boolean });

/**
 * A linked environment that answers every MCP request, and this machine's own list, which may
 * narrow at any step of a call: `narrowAt` names the step after which it does.
 */
const makeClient = (narrowAt: "resolve" | "initialize" | "first-call") =>
  Effect.gen(function* () {
    const writable = yield* Ref.make(true);
    const sent: Array<string> = [];
    let calls = 0;
    const narrow = Ref.set(writable, false);
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const method = (JSON.parse(body) as { readonly method: string }).method;
        sent.push(method);
        if (method === "initialize") {
          if (narrowAt === "initialize") yield* narrow;
          return HttpClientResponse.fromWeb(
            request,
            new Response("{}", { status: 200, headers: { "mcp-session-id": "session" } }),
          );
        }
        if (method !== "tools/call") return HttpClientResponse.fromWeb(request, new Response(null));
        calls += 1;
        // The peer restarted and lost the session: the client starts a new one and retries.
        if (narrowAt === "first-call" && calls === 1) {
          yield* narrow;
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
          }),
        );
      }),
    );
    const client = yield* PeerMcpClient.PeerMcpClient.pipe(
      Effect.provide(
        PeerMcpClient.layer.pipe(
          Layer.provide(
            Layer.mock(PeerLinks.PeerLinks)({
              resolve: () =>
                (narrowAt === "resolve" ? narrow : Effect.void).pipe(
                  Effect.as({
                    link: {} as PeerLinks.ResolvedPeerLink["link"],
                    url: "https://peer.test",
                    token: "standard-token",
                  }),
                ),
              recordOutcome: () => Effect.void,
            }),
          ),
          Layer.provide(
            Layer.succeed(PeerMcpClient.PeerWriteCeiling, { writable: () => Ref.get(writable) }),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
        ),
      ),
    );
    const call = (writes: boolean) =>
      client
        .call({
          environmentId: peer,
          tool: "anything",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          writes,
          success: Answer,
        })
        .pipe(
          Effect.map(() => "answered"),
          Effect.catchTags({ OrchestratorMcpFailure: (failure) => Effect.succeed(failure.code) }),
        );
    return { call, sent };
  });

const toolCalls = (sent: ReadonlyArray<string>) =>
  sent.filter((method) => method === "tools/call").length;

it.effect("never sends a write once this machine's list narrows while the link resolves", () =>
  Effect.gen(function* () {
    const { call, sent } = yield* makeClient("resolve");
    expect(yield* call(true)).toBe("capability_denied");
    expect(toolCalls(sent)).toBe(0);
    // The link keeps reading.
    expect(yield* call(false)).toBe("answered");
  }),
);

it.effect("never sends a write once this machine's list narrows while a session starts", () =>
  Effect.gen(function* () {
    const { call, sent } = yield* makeClient("initialize");
    expect(yield* call(true)).toBe("capability_denied");
    expect(sent).toContain("initialize");
    expect(toolCalls(sent)).toBe(0);
    expect(yield* call(false)).toBe("answered");
  }),
);

it.effect("never retries a write once this machine's list narrows before the retry", () =>
  Effect.gen(function* () {
    const { call, sent } = yield* makeClient("first-call");
    expect(yield* call(true)).toBe("capability_denied");
    // The first send was allowed; the session it found was gone, and the retry is refused.
    expect(toolCalls(sent)).toBe(1);
    expect(sent.filter((method) => method === "initialize")).toHaveLength(2);
    expect(yield* call(false)).toBe("answered");
  }),
);
