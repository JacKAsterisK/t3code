import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import { parseLanBuildIdentity } from "@t3tools/shared/distribution";
import {
  lanBuildDefines,
  lanBuildEnvironment,
  loadLanBuildPolicy,
  transformLanIndexHtml,
  transformLanWebManifest,
} from "./lan-build-policy.ts";

const identity = () =>
  parseLanBuildIdentity({
    appId: "com.example.lanfixture",
    productName: "LAN Fixture",
    protocolScheme: "lan-fixture",
    homeDirectoryName: "T3CodeLAN",
    telemetry: "disabled",
    cloudConfiguration: "disabled",
    nativeUpdater: "disabled",
    protocolVersion: 2,
    applicationVersion: "0.1.2",
    sourceCommit: "a".repeat(40),
  });

it("default compiler selection reads no file and retains upstream undefined policy", () => {
  const result = loadLanBuildPolicy({}, () => {
    throw new Error("unexpected file read");
  });
  NodeAssert.equal(result, undefined);
  NodeAssert.deepEqual(lanBuildDefines(result), { __T3_LAN_BUILD_IDENTITY__: "undefined" });
  NodeAssert.deepEqual(lanBuildDefines(result, true), {});
  NodeAssert.deepEqual(lanBuildEnvironment(undefined), {
    T3CODE_LAN_BUILD_POLICY: "",
    T3CODE_LAN_BUILD_POLICY_SHA256: "",
  });
});

it("brands only public HTML and PWA labels while preserving embedded scripts and upstream defaults", () => {
  const script = '<script>const label = "T3 Code";</script>';
  const html = `${script}<title>T3 Code (Beta)</title><div aria-label="T3 Code splash screen"><img alt="T3 Code"></div>`;
  const selected = { ...identity(), productName: "LAN & Fixture" };
  const result = transformLanIndexHtml(html, selected);
  NodeAssert.equal(result.includes(script), true);
  NodeAssert.equal(result.includes("<title>LAN &amp; Fixture</title>"), true);
  NodeAssert.equal(transformLanIndexHtml(html, undefined), html);
  NodeAssert.equal(
    JSON.parse(
      transformLanWebManifest(
        Buffer.from('{"name":"T3 Code","short_name":"T3 Code","start_url":"/"}'),
        selected,
      ),
    ).name,
    selected.productName,
  );
  NodeAssert.throws(
    () => transformLanIndexHtml("<title>changed template</title>", selected),
    /anchors/u,
  );
});

it("compiler policy digest binds all entries to one immutable public identity", () => {
  const selected = {
    path: "C:\\Approved\\fixture-policy.json",
    sha256: "b".repeat(64),
    identity: identity(),
  };
  const env = lanBuildEnvironment(selected);
  NodeAssert.equal(
    loadLanBuildPolicy(env, () => selected),
    selected.identity,
  );
  NodeAssert.equal(
    lanBuildDefines(selected.identity).__T3_LAN_BUILD_IDENTITY__,
    JSON.stringify(selected.identity),
  );
  NodeAssert.throws(
    () => loadLanBuildPolicy({ T3CODE_LAN_BUILD_POLICY: selected.path }, () => selected),
    /SHA-256/u,
  );
  NodeAssert.throws(
    () => loadLanBuildPolicy(env, () => ({ ...selected, sha256: "c".repeat(64) })),
    /changed/u,
  );
  NodeAssert.throws(
    () => loadLanBuildPolicy({ T3CODE_LAN_BUILD_POLICY_SHA256: selected.sha256 }),
    /no policy/u,
  );
  NodeAssert.equal(Object.isFrozen(selected.identity), true);
});
