// @effect-diagnostics nodeBuiltinImport:off -- Real SQLite files verify bounded change detection and recovery-copy equivalence.
import { afterEach, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { nativeDataGeneration } from "./NativeDataGeneration.ts";

const roots: string[] = [];
const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-fingerprint-"));
  roots.push(root);
  const path = NodePath.join(root, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE history(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO history(body) VALUES ('before')",
  );
  db.close();
  return path;
};
const safeFile = (path: string) => {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe file");
  return stat;
};
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true });
});
it("treats absent and read-only-created empty WAL as the same generation", () => {
  const path = fixture();
  const before = nativeDataGeneration(path, safeFile);
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  db.prepare("SELECT * FROM history").all();
  expect(NodeFS.statSync(path + "-wal").size).toBe(0);
  expect(nativeDataGeneration(path, safeFile)).toBe(before);
  db.close();
  expect(nativeDataGeneration(path, safeFile)).toBe(before);
});
it("detects a committed WAL write even when the main database is unchanged", () => {
  const path = fixture();
  const db = new NodeSqlite.DatabaseSync(path);
  try {
    db.prepare("SELECT * FROM history").all();
    const before = nativeDataGeneration(path, safeFile);
    const main = NodeFS.readFileSync(path);
    db.exec("UPDATE history SET body='after'");
    expect(NodeFS.readFileSync(path)).toEqual(main);
    expect(nativeDataGeneration(path, safeFile)).not.toBe(before);
  } finally {
    db.close();
  }
});
it("detects same-size WAL reuse through the frame checksum even with an unchanged timestamp", () => {
  const path = fixture();
  const db = new NodeSqlite.DatabaseSync(path);
  try {
    db.exec("UPDATE history SET body='first'; PRAGMA wal_checkpoint(RESTART)");
    const wal = path + "-wal";
    const stamp = 1_700_000_000;
    NodeFS.utimesSync(wal, stamp, stamp);
    const before = nativeDataGeneration(path, safeFile);
    const size = NodeFS.statSync(wal).size;
    db.exec("UPDATE history SET body='other'");
    NodeFS.utimesSync(wal, stamp, stamp);
    expect(NodeFS.statSync(wal).size).toBe(size);
    expect(nativeDataGeneration(path, safeFile)).not.toBe(before);
  } finally {
    db.close();
  }
});
it("keeps the fingerprint when a recovery copy restores bytes and the write timestamp", () => {
  const path = fixture();
  const stamp = 1_700_000_000;
  NodeFS.utimesSync(path, stamp, stamp);
  const before = nativeDataGeneration(path, safeFile);
  const backup = path + ".backup";
  NodeFS.copyFileSync(path, backup);
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec("UPDATE history SET body='after'");
  db.close();
  expect(nativeDataGeneration(path, safeFile)).not.toBe(before);
  NodeFS.copyFileSync(backup, path);
  NodeFS.utimesSync(path, stamp, stamp);
  expect(nativeDataGeneration(path, safeFile)).toBe(before);
});
it("retains the ordinary single-link file guard", () => {
  const path = fixture();
  NodeFS.linkSync(path, path + ".link");
  expect(() => nativeDataGeneration(path, safeFile)).toThrow("unsafe file");
});
