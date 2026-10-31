import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [manager, ...args] = process.argv.slice(2);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone tool subprocess has no Effect runtime.
const windows = process.platform === "win32";
const writeExecutable = (directory, name) => {
  NodeFS.mkdirSync(directory, { recursive: true });
  const target = NodePath.join(directory, `${name}${windows ? ".CMD" : ""}`);
  NodeFS.writeFileSync(target, windows ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
};
const output = (text) => process.stdout.write(`${text}\n`);
if (manager === "npm") {
  NodeFS.appendFileSync(process.env.FAKE_NPM_LOG, `${args.join(" ")}\n`);
  const prefix = process.env.npm_config_prefix ?? process.env.FAKE_NPM_PREFIX;
  const modules = windows
    ? NodePath.join(prefix, "node_modules")
    : NodePath.join(prefix, "lib", "node_modules");
  if (args[0] === "root" && args[1] === "--global") output(modules);
  else if (args[0] === "prefix" && args[1] === "--global") output(prefix);
  else if (args[0] === "install" && args[1] === "--global") {
    const packageRoot = NodePath.join(modules, "@example", "acp");
    NodeFS.mkdirSync(packageRoot, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(packageRoot, "package.json"), process.env.FAKE_NPM_MANIFEST);
    writeExecutable(windows ? prefix : NodePath.join(prefix, "bin"), "example-agent");
  } else process.exitCode = 64;
} else if (manager === "uv") {
  NodeFS.appendFileSync(process.env.FAKE_UV_LOG, `${args.join(" ")}\n`);
  const bin = process.env.UV_TOOL_BIN_DIR ?? process.env.FAKE_UV_BIN;
  NodeFS.appendFileSync(
    process.env.FAKE_UV_LOG,
    `tool-dir=${process.env.UV_TOOL_DIR} bin-dir=${process.env.UV_TOOL_BIN_DIR}\n`,
  );
  const executable = NodePath.join(bin, `fast-agent${windows ? ".CMD" : ""}`);
  if (args[0] === "tool" && args[1] === "dir" && args[2] === "--bin") output(bin);
  else if (args[0] === "tool" && args[1] === "list") {
    if (NodeFS.existsSync(executable)) output("fast-agent-acp v0.10.1\n- fast-agent");
  } else if (args[0] === "tool" && args[1] === "install" && args[2] === "--force") {
    writeExecutable(bin, "fast-agent");
  } else process.exitCode = 64;
} else process.exitCode = 64;
