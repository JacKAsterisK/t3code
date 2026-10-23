import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuthGrants from "./McpOAuthGrants.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-grants-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const input = {
  clientId: "approved-client",
  resource: "https://anvil.example/mcp",
  access: "auto" as const,
  client: { label: "dot", deviceType: "bot" as const },
  renewable: true,
};
const request = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request(input.resource, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

it.effect("fails closed when token verification races refresh rotation", () =>
  Effect.gen(function* () {
    const grants = yield* McpOAuthGrants.McpOAuthGrants;
    const sessions = yield* SessionStore.SessionStore;
    const verified = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const first = yield* grants.issue(input);
    const pausedAuth = yield* EnvironmentAuth.make.pipe(
      Effect.provideService(SessionStore.SessionStore, {
        ...sessions,
        verify: (token) =>
          sessions
            .verify(token)
            .pipe(
              Effect.tap(() =>
                Deferred.succeed(verified, undefined).pipe(Effect.andThen(Deferred.await(resume))),
              ),
            ),
      }),
    );
    const pending = yield* pausedAuth
      .authenticateMcpClient(request(first.token))
      .pipe(Effect.forkChild);
    yield* Deferred.await(verified);
    yield* grants.refresh({ ...input, token: first.refreshToken! });
    yield* Deferred.succeed(resume, undefined);
    expect(yield* Fiber.join(pending).pipe(Effect.isFailure)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("rotates hashed refresh credentials while preserving grant identity and authority", () =>
  Effect.gen(function* () {
    const grants = yield* McpOAuthGrants.McpOAuthGrants;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* grants.issue(input);
    expect(first.expiresIn).toBe(3600);
    expect(first.refreshExpiresIn).toBe(90 * 24 * 3600);
    const initial = yield* auth.authenticateMcpClient(request(first.token));
    expect(initial).toMatchObject({ grantId: first.grantId, taskOnly: true, access: "auto" });
    const rows = yield* sql`SELECT token_hash FROM auth_mcp_refresh_tokens`;
    expect(JSON.stringify(rows)).not.toContain(first.refreshToken);
    const next = yield* grants.refresh({ ...input, token: first.refreshToken! });
    expect(next.grantId).toBe(first.grantId);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    const rotated = yield* auth.authenticateMcpClient(request(next.token));
    expect(rotated.sessionId).not.toBe(initial.sessionId);
    expect(rotated).toMatchObject({ grantId: first.grantId, taskOnly: true, access: "auto" });
    expect(yield* auth.authenticateMcpClient(request(first.token)).pipe(Effect.isFailure)).toBe(
      true,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses another client and resource without spending the approved refresh", () =>
  Effect.gen(function* () {
    const grants = yield* McpOAuthGrants.McpOAuthGrants;
    const first = yield* grants.issue(input);
    for (const wrong of [{ clientId: "other" }, { resource: "https://other.example/mcp" }]) {
      expect(
        yield* grants
          .refresh({ ...input, token: first.refreshToken!, ...wrong })
          .pipe(Effect.isFailure),
      ).toBe(true);
    }
    expect((yield* grants.refresh({ ...input, token: first.refreshToken! })).grantId).toBe(
      first.grantId,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "commits replay revocation and blocks the whole family after service reconstruction",
  () =>
    Effect.gen(function* () {
      const grants = yield* McpOAuthGrants.McpOAuthGrants;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const first = yield* grants.issue(input);
      const next = yield* grants.refresh({ ...input, token: first.refreshToken! });
      const replay = yield* McpOAuthGrants.McpOAuthGrants.pipe(
        Effect.flatMap((recreated) => recreated.refresh({ ...input, token: first.refreshToken! })),
        Effect.provide(McpOAuthGrants.layer),
        Effect.isFailure,
      );
      expect(replay).toBe(true);
      expect(yield* auth.authenticateMcpClient(request(next.token)).pipe(Effect.isFailure)).toBe(
        true,
      );
      expect(
        yield* grants.refresh({ ...input, token: next.refreshToken! }).pipe(Effect.isFailure),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect("requires new approval after absolute expiry and retains a read-only ceiling", () =>
  Effect.gen(function* () {
    const grants = yield* McpOAuthGrants.McpOAuthGrants;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const first = yield* grants.issue({ ...input, access: "read-only" });
    const client = yield* auth.authenticateMcpClient(request(first.token));
    yield* TestClock.adjust("2 hours");
    expect(yield* auth.authenticateMcpClient(request(first.token)).pipe(Effect.isFailure)).toBe(
      true,
    );
    expect((yield* auth.listSessions()).some((entry) => entry.sessionId === client.sessionId)).toBe(
      true,
    );
    const next = yield* grants.refresh({ ...input, token: first.refreshToken! });
    expect((yield* auth.authenticateMcpClient(request(next.token))).access).toBe("read-only");
    yield* TestClock.adjust("90 days");
    expect(
      yield* grants.refresh({ ...input, token: next.refreshToken! }).pipe(Effect.isFailure),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("native session revocation and explicit refresh revocation both stop renewal", () =>
  Effect.gen(function* () {
    const grants = yield* McpOAuthGrants.McpOAuthGrants;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const first = yield* grants.issue(input);
    const client = yield* auth.authenticateMcpClient(request(first.token));
    const rotated = yield* grants.refresh({ ...input, token: first.refreshToken! });
    yield* auth.revokeSession(client.sessionId);
    expect(
      yield* grants.refresh({ ...input, token: rotated.refreshToken! }).pipe(Effect.isFailure),
    ).toBe(true);
    const second = yield* grants.issue(input);
    yield* grants.revoke({ ...input, token: second.refreshToken! });
    expect(yield* auth.authenticateMcpClient(request(second.token)).pipe(Effect.isFailure)).toBe(
      true,
    );
    expect(
      yield* grants.refresh({ ...input, token: second.refreshToken! }).pipe(Effect.isFailure),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);
