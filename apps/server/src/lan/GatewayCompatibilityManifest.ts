// @effect-diagnostics nodeBuiltinImport:off -- Incremental hashes bound backup validation memory to one retained row.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { digest } from "../agentEvents/AgentGatewayCompatibilityFacts.ts";

const hash = () => NodeCrypto.createHash("sha256");
const add = (target: ReturnType<typeof hash>, value: unknown) => {
  const json = stableStringify(value);
  target
    .update(String(Buffer.byteLength(json, "utf8")))
    .update(":")
    .update(json);
};

/** Deterministic keyset pages preserve multiplicity, BLOBs and exact payload bytes in a fixed read transaction. */
export const manifest = Effect.fn("GatewayCompatibility.manifest")(function* (
  schema: "main" | "gateway_compatibility_backup",
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
    sql: string;
  }>`SELECT name, sql FROM ${sql(schema)}.sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('agent_gateway_compatibility_state', 'agent_gateway_compatibility_backups', 'agent_gateway_compatibility_shadows') ORDER BY name`;
  const rows: Array<{
    table: string;
    schemaDigest: string;
    rowCount: number;
    payloadDigest: string;
    category: "work" | "nonwork";
  }> = [];
  const secretHash = hash();
  let secretCount = 0;
  for (const table of tables) {
    const columns = yield* sql<{
      name: string;
      pk: number;
    }>`PRAGMA ${sql(schema)}.table_info(${sql(table.name)})`;
    const hidden = ["_rowid_", "rowid", "oid"].find(
      (key) => !columns.some((column) => column.name.toLowerCase() === key),
    );
    const keys =
      /WITHOUT\s+ROWID/iu.test(table.sql) || hidden === undefined
        ? columns
            .filter((column) => column.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((column) => column.name)
        : [hidden];
    if (keys.length === 0)
      return yield* Effect.die(new Error("Backup table has no stable row key: " + table.name));
    let prefix = "__gateway_key_";
    while (columns.some((column) => column.name.toLowerCase().startsWith(prefix)))
      prefix = "_" + prefix;
    const order = sql.join(", ", false)(keys.map((key) => sql`${sql(key)}`));
    let cursor: ReadonlyArray<unknown> | undefined;
    const payloadHash = hash();
    let count = 0;
    while (true) {
      // One row also bounds pages containing maximum-size private facts or retained BLOBs.
      const page = yield* sql<
        Record<string, unknown>
      >`SELECT *, ${sql.join(", ", false)(keys.map((key, index) => sql`${sql(key)} AS ${sql(prefix + index)}`))}
        FROM ${sql(schema)}.${sql(table.name)}
        ${cursor === undefined ? sql`` : sql`WHERE (${order}) > (${sql.join(", ", false)(cursor.map((value) => sql`${value}`))})`}
        ORDER BY ${order} LIMIT 1`;
      if (page.length === 0) break;
      const row = { ...page[0]! };
      cursor = keys.map((_, index) => row[prefix + index]);
      for (let index = 0; index < keys.length; index++) delete row[prefix + index];
      add(payloadHash, row);
      for (const key of Object.keys(row).sort()) {
        const value = row[key];
        if (/(?:secret|credential).*ref/iu.test(key) && value !== null) {
          add(secretHash, [table.name, key, value]);
          secretCount++;
        }
      }
      count++;
    }
    rows.push({
      table: table.name,
      schemaDigest: digest(table.sql),
      rowCount: count,
      payloadDigest: payloadHash.digest("hex"),
      category: table.name.startsWith("orchestration_") ? "work" : "nonwork",
    });
  }
  return {
    version: 2,
    tables: rows,
    secretReferences: { count: secretCount, digest: secretHash.digest("hex") },
    workGeneration: digest(rows.filter((row) => row.category === "work")),
    nonworkPayloads: digest(rows.filter((row) => row.category === "nonwork")),
  };
});
