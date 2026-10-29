import {
  AuthMcpClientAccess,
  AuthSessionId,
  type AuthClientMetadata,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as CredentialAttribution from "./CredentialAttribution.ts";
import * as SessionStore from "./SessionStore.ts";

const ACCESS_TTL_SECONDS = 60 * 60;
const GRANT_TTL_SECONDS = 90 * 24 * 60 * 60;

export class McpOAuthGrantError extends Schema.TaggedError<McpOAuthGrantError>()(
  "McpOAuthGrantError",
  {
    reason: Schema.Literals(["invalid_grant", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "invalid_grant"
      ? "The task grant is invalid, expired or revoked. Approve a new sign-in."
      : "The task grant could not be stored.";
  }
}

interface IssuedGrant {
  readonly token: string;
  readonly expiresIn: number;
  readonly grantId: string;
  readonly access: AuthMcpClientAccess;
  readonly refreshToken?: string;
  readonly refreshExpiresIn?: number;
}

const GrantRow = Schema.Struct({
  grantId: Schema.String,
  clientId: Schema.String,
  resource: Schema.String,
  sessionId: AuthSessionId,
  access: AuthMcpClientAccess,
  expiresAt: Schema.Number,
  renewable: Schema.Number,
  revokedAt: Schema.NullOr(Schema.Number),
  sessionRevokedAt: Schema.NullOr(Schema.String),
  clientLabel: Schema.NullOr(Schema.String),
  subject: Schema.String,
  spent: Schema.Number,
});
const decodeGrantRow = Schema.decodeUnknownEffect(GrantRow);
const decodeBindingRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    grantId: Schema.String,
    currentSessionId: AuthSessionId,
    sessionRevokedAt: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
    revokedAt: Schema.NullOr(Schema.Number),
  }),
);
const decodeSessionGrantRow = Schema.decodeUnknownEffect(
  Schema.Struct({ grantId: Schema.String, sessionId: AuthSessionId }),
);

export class McpOAuthGrants extends Context.Service<
  McpOAuthGrants,
  {
    readonly issue: (input: {
      readonly clientId: string;
      readonly resource: string;
      readonly access: AuthMcpClientAccess;
      readonly client: AuthClientMetadata;
      readonly renewable: boolean;
      /** Its sessions' subject, which says who approved it; kept across refreshes. */
      readonly subject?: string;
    }) => Effect.Effect<IssuedGrant, McpOAuthGrantError>;
    readonly binding: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<
      Option.Option<{ readonly grantId: string; readonly taskOnly: true }>,
      McpOAuthGrantError
    >;
    readonly refresh: (input: {
      readonly clientId: string;
      readonly resource: string;
      readonly token: string;
      readonly client: AuthClientMetadata;
      /**
       * Who holds the grant, proven by its fleet machine. It applies only to a grant from before
       * grants recorded their approver; one with an approver is never re-attributed.
       */
      readonly holder?: { readonly grantId: string; readonly subject: string };
    }) => Effect.Effect<IssuedGrant, McpOAuthGrantError>;
    /** Whether a refresh token names a live grant from before grants recorded their approver. */
    readonly unattributed: (input: {
      readonly clientId: string;
      readonly resource: string;
      readonly token: string;
    }) => Effect.Effect<boolean, McpOAuthGrantError>;
    readonly revoke: (input: {
      readonly clientId: string;
      readonly resource: string;
      readonly token: string;
    }) => Effect.Effect<void, McpOAuthGrantError>;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, McpOAuthGrantError>;
  }
>()("t3/auth/McpOAuthGrants") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionStore.SessionStore;
  const crypto = yield* Crypto.Crypto;
  const storageError = (cause: unknown) => new McpOAuthGrantError({ reason: "storage", cause });
  const invalid = () => new McpOAuthGrantError({ reason: "invalid_grant" });
  const hashToken = Effect.fn("McpOAuthGrants.hashToken")(function* (token: string) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.mapError(storageError));
    return Buffer.from(digest).toString("hex");
  });
  const secret = crypto.randomBytes(32).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
    Effect.mapError(storageError),
  );

  const issueSession = Effect.fn("McpOAuthGrants.issueSession")(function* (
    access: AuthMcpClientAccess,
    client: AuthClientMetadata,
    ttlSeconds: number,
    sessionSeconds: number,
    subject: string,
  ) {
    return yield* sessions
      .issue({
        subject,
        method: "bearer-access-token",
        scopes:
          access === "read-only"
            ? [AuthOrchestrationReadScope]
            : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        ttl: Duration.seconds(ttlSeconds),
        sessionTtl: Duration.seconds(sessionSeconds),
        ...(access === "read-only" ? {} : { runtimeModeCeiling: access }),
        client: { ...client, deviceType: "bot" },
      })
      .pipe(Effect.mapError(storageError));
  });

  const issue: McpOAuthGrants["Service"]["issue"] = Effect.fn("McpOAuthGrants.issue")(
    function* (input) {
      if (input.access === "full-access") return yield* invalid();
      const now = yield* Clock.currentTimeMillis;
      const grantId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
      const ttl = input.renewable ? ACCESS_TTL_SECONDS : 30 * 24 * 60 * 60;
      const expiresIn = input.renewable ? GRANT_TTL_SECONDS : ttl;
      const refreshToken = input.renewable ? yield* secret : undefined;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const issued = yield* issueSession(
              input.access,
              input.client,
              ttl,
              expiresIn,
              input.subject ?? "mcp-client",
            );
            yield* sql`INSERT INTO auth_mcp_grants
          (grant_id, client_id, resource, session_id, access, expires_at, renewable)
          VALUES (${grantId}, ${input.clientId}, ${input.resource}, ${issued.sessionId},
            ${input.access}, ${now + expiresIn * 1000}, ${input.renewable ? 1 : 0})`;
            yield* sql`INSERT INTO auth_mcp_grant_sessions(session_id, grant_id) VALUES (${issued.sessionId}, ${grantId})`;
            if (refreshToken !== undefined) {
              yield* sql`INSERT INTO auth_mcp_refresh_tokens(token_hash, grant_id)
            VALUES (${yield* hashToken(refreshToken)}, ${grantId})`;
            }
            return {
              token: issued.token,
              expiresIn: ttl,
              grantId,
              access: input.access,
              ...(refreshToken === undefined ? {} : { refreshToken, refreshExpiresIn: expiresIn }),
            };
          }),
        )
        .pipe(Effect.mapError(storageError));
    },
  );

  const binding: McpOAuthGrants["Service"]["binding"] = Effect.fn("McpOAuthGrants.binding")(
    function* (sessionId) {
      const rows = yield* sql`SELECT g.grant_id AS "grantId", g.session_id AS "currentSessionId",
        g.expires_at AS "expiresAt", g.revoked_at AS "revokedAt", s.revoked_at AS "sessionRevokedAt"
        FROM auth_mcp_grant_sessions gs JOIN auth_mcp_grants g ON g.grant_id = gs.grant_id
        JOIN auth_sessions s ON s.session_id = gs.session_id WHERE gs.session_id = ${sessionId}`.pipe(
        Effect.mapError(storageError),
      );
      if (rows.length === 0) return Option.none();
      const row = yield* decodeBindingRow(rows[0]).pipe(Effect.mapError(storageError));
      if (
        row.currentSessionId !== sessionId ||
        row.sessionRevokedAt !== null ||
        row.revokedAt !== null ||
        row.expiresAt <= (yield* Clock.currentTimeMillis)
      ) {
        return yield* invalid();
      }
      return Option.some({ grantId: row.grantId, taskOnly: true as const });
    },
  );

  const findToken = Effect.fn("McpOAuthGrants.findToken")(function* (token: string) {
    if (token.length > 512) return Option.none<typeof GrantRow.Type>();
    const rows = yield* sql`SELECT g.grant_id AS "grantId", g.client_id AS "clientId",
      g.resource, g.session_id AS "sessionId", g.access, g.expires_at AS "expiresAt",
      g.renewable, g.revoked_at AS "revokedAt", s.revoked_at AS "sessionRevokedAt", s.client_label AS "clientLabel", s.subject, t.spent
      FROM auth_mcp_refresh_tokens t JOIN auth_mcp_grants g ON g.grant_id = t.grant_id
      JOIN auth_sessions s ON s.session_id = g.session_id WHERE t.token_hash = ${yield* hashToken(token)}`.pipe(
      Effect.mapError(storageError),
    );
    return rows.length === 0
      ? Option.none()
      : Option.some(yield* decodeGrantRow(rows[0]).pipe(Effect.mapError(storageError)));
  });

  const revokeGrant = Effect.fn("McpOAuthGrants.revokeGrant")(function* (
    grant: typeof GrantRow.Type,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE auth_mcp_grants SET revoked_at = ${now}
      WHERE grant_id = ${grant.grantId} AND revoked_at IS NULL`.pipe(Effect.mapError(storageError));
    yield* sessions.revoke(grant.sessionId).pipe(Effect.mapError(storageError));
  });

  const refresh: McpOAuthGrants["Service"]["refresh"] = Effect.fn("McpOAuthGrants.refresh")(
    function* (input) {
      // Commit replay revocation before reporting invalid_grant; failing inside the
      // transaction would roll back the revocation as well.
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* findToken(input.token);
            if (Option.isNone(found)) return Option.none<IssuedGrant>();
            const grant = found.value;
            if (grant.clientId !== input.clientId || grant.resource !== input.resource)
              return Option.none<IssuedGrant>();
            if (grant.spent !== 0) {
              yield* revokeGrant(grant);
              return Option.none<IssuedGrant>();
            }
            const now = yield* Clock.currentTimeMillis;
            if (
              grant.revokedAt !== null ||
              grant.sessionRevokedAt !== null ||
              grant.expiresAt <= now ||
              grant.renewable !== 1
            ) {
              return Option.none<IssuedGrant>();
            }
            const nextToken = yield* secret;
            const ttl = Math.min(ACCESS_TTL_SECONDS, Math.floor((grant.expiresAt - now) / 1000));
            const issued = yield* issueSession(
              grant.access,
              {
                ...input.client,
                ...(grant.clientLabel === null ? {} : { label: grant.clientLabel }),
              },
              ttl,
              Math.floor((grant.expiresAt - now) / 1000),
              grant.subject === CredentialAttribution.MCP_CLIENT_SUBJECT &&
                input.holder?.grantId === grant.grantId
                ? input.holder.subject
                : grant.subject,
            );
            yield* sql`UPDATE auth_mcp_refresh_tokens SET spent = 1 WHERE token_hash = ${yield* hashToken(input.token)}`;
            yield* sql`INSERT INTO auth_mcp_refresh_tokens(token_hash, grant_id) VALUES (${yield* hashToken(nextToken)}, ${grant.grantId})`;
            yield* sql`UPDATE auth_mcp_grants SET session_id = ${issued.sessionId} WHERE grant_id = ${grant.grantId}`;
            yield* sql`INSERT INTO auth_mcp_grant_sessions(session_id, grant_id) VALUES (${issued.sessionId}, ${grant.grantId})`;
            yield* sessions.revoke(grant.sessionId).pipe(Effect.mapError(storageError));
            return Option.some({
              token: issued.token,
              expiresIn: ttl,
              grantId: grant.grantId,
              access: grant.access,
              refreshToken: nextToken,
              refreshExpiresIn: Math.floor((grant.expiresAt - now) / 1000),
            });
          }),
        )
        .pipe(Effect.mapError(storageError));
      if (Option.isNone(result)) return yield* invalid();
      return result.value;
    },
  );

  const revoke: McpOAuthGrants["Service"]["revoke"] = Effect.fn("McpOAuthGrants.revoke")(
    function* (input) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* findToken(input.token);
            if (
              Option.isSome(found) &&
              found.value.clientId === input.clientId &&
              found.value.resource === input.resource
            ) {
              yield* revokeGrant(found.value);
            }
          }),
        )
        .pipe(Effect.mapError(storageError));
    },
  );
  const revokeSession: McpOAuthGrants["Service"]["revokeSession"] = Effect.fn(
    "McpOAuthGrants.revokeSession",
  )(function* (sessionId) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`SELECT g.grant_id AS "grantId", g.session_id AS "sessionId"
          FROM auth_mcp_grants g JOIN auth_mcp_grant_sessions s ON s.grant_id = g.grant_id
          WHERE s.session_id = ${sessionId} AND g.revoked_at IS NULL`;
          if (rows.length === 0) return false;
          const row = yield* decodeSessionGrantRow(rows[0]);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE auth_mcp_grants SET revoked_at = ${now} WHERE grant_id = ${row.grantId}`;
          yield* sessions.revoke(row.sessionId);
          return true;
        }),
      )
      .pipe(Effect.mapError(storageError));
  });
  const unattributed: McpOAuthGrants["Service"]["unattributed"] = Effect.fn(
    "McpOAuthGrants.unattributed",
  )(function* (input) {
    const found = yield* findToken(input.token);
    if (Option.isNone(found)) return false;
    const grant = found.value;
    return (
      grant.clientId === input.clientId &&
      grant.resource === input.resource &&
      grant.spent === 0 &&
      grant.revokedAt === null &&
      grant.sessionRevokedAt === null &&
      grant.subject === CredentialAttribution.MCP_CLIENT_SUBJECT
    );
  });

  return McpOAuthGrants.of({ issue, binding, refresh, unattributed, revoke, revokeSession });
});

export const layer = Layer.effect(McpOAuthGrants, make);
