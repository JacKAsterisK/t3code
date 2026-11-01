import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";
import * as Diagnostic from "./McpDiscoveryDiagnostics.ts";
import { patchCapabilities } from "./McpEventsEndpoint.ts";

it.effect(
  "observes stream/shape decisions without consuming streams or changing response bytes",
  () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ message }) => {
      if (Array.isArray(message) && message[0] === "MCP discovery metadata")
        records.push(message[1] as Record<string, unknown>);
    });
    return Effect.gen(function* () {
      let pulled = false;
      const responses = [
        HttpServerResponse.stream(
          Stream.fromEffect(
            Effect.sync(() => {
              pulled = true;
              return new TextEncoder().encode("private-stream");
            }),
          ),
          { contentType: "text/event-stream" },
        ),
        HttpServerResponse.text('{"jsonrpc":"2.0","id":1,"result":{}}', {
          contentType: "application/json",
        }),
        HttpServerResponse.text("private-non-json", {
          contentType: "text/plain; callback=https://private.example/?token=private-canary",
        }),
        HttpServerResponse.empty({ status: 403 }),
      ];
      const decisions = [
        "skipped_non_materialized",
        "skipped_shape",
        "skipped_content_type",
        "skipped_http_status",
      ];
      for (const [index, response] of responses.entries()) {
        const diagnostic = Diagnostic.begin({
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        });
        diagnostic.admission = "accepted";
        const returned = yield* patchCapabilities("server/discover", response, diagnostic);
        assert.strictEqual(returned, response);
        yield* Diagnostic.logResponse(diagnostic, returned);
        yield* Diagnostic.logResponse(diagnostic, returned);
        assert.strictEqual(records[index]?.capabilityInjection, decisions[index]);
      }
      assert.strictEqual(pulled, false);
      assert.strictEqual(records.length, 4);
      assert.isNull(records[0]?.eventsCapabilityPresent);
      assert.strictEqual(records[1]?.eventsCapabilityPresent, false);
      assert.strictEqual(records[2]?.contentType, "text/plain");
      assert.notInclude(JSON.stringify(records), "private-");
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  },
);

it.effect(
  "allowlists metadata, bounds JSON inspection and never copies external ids or errors",
  () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ message }) => {
      if (Array.isArray(message) && message[0] === "MCP discovery metadata")
        records.push(message[1] as Record<string, unknown>);
    });
    return Effect.gen(function* () {
      const secret = "private-diagnostic-canary";
      const diagnostic = Diagnostic.begin({
        "mcp-method": "events/list",
        "mcp-protocol-version": secret,
        authorization: "Bearer " + secret,
        cookie: secret,
        origin: "https://private.example/?token=" + secret,
        "mcp-session-id": secret,
        "x-request-id": secret,
      });
      Diagnostic.inspectRequest(
        diagnostic,
        JSON.stringify({
          method: "events/list",
          id: secret,
          params: {
            protocolVersion: secret,
            _meta: { "io.modelcontextprotocol/protocolVersion": secret },
            callback: "https://private.example/?secret=" + secret,
            secret,
          },
        }),
      );
      yield* Diagnostic.logResponse(
        diagnostic,
        HttpServerResponse.text(
          JSON.stringify({ error: { code: -32602, message: secret, data: { secret } } }),
          {
            status: 400,
            contentType: "application/json; callback=" + secret,
            headers: {
              "mcp-protocol-version": secret,
              "mcp-session-id": secret,
              "set-cookie": secret,
            },
          },
        ),
      );
      assert.strictEqual(records[0]?.protocolVersion, "invalid");
      assert.strictEqual(records[0]?.errorCategory, "invalid_params");
      assert.strictEqual(records[0]?.originPresent, true);
      assert.strictEqual(records[0]?.sessionIdPresent, true);
      const large = Diagnostic.begin({ "mcp-method": "server/discover" });
      Diagnostic.inspectRequest(
        large,
        JSON.stringify({ method: "initialize", private: secret.repeat(6000) }),
      );
      yield* Diagnostic.logResponse(
        large,
        HttpServerResponse.text(
          JSON.stringify({
            result: { capabilities: { events: {} }, private: secret.repeat(6000) },
          }),
          { contentType: "application/json" },
        ),
      );
      assert.strictEqual(records[1]?.rpcMethod, "server/discover");
      assert.isNull(records[1]?.eventsCapabilityPresent);
      assert.notInclude(JSON.stringify(records), secret);
      assert.notInclude(JSON.stringify(records), "https:");
      assert.isFalse(
        Diagnostic.mayInspectRequestBody({
          "content-type": "text/plain",
          accept: "application/json, text/event-stream",
        }),
      );
      assert.isFalse(
        Diagnostic.mayInspectRequestBody({
          "content-type": "application/json",
          accept: "application/json",
        }),
      );
      assert.isFalse(
        Diagnostic.mayInspectRequestBody({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          origin: secret,
        }),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  },
);
