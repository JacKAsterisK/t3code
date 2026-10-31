// Eval-only helper: reads process-local proxy credentials at startup.
// @effect-diagnostics nodeBuiltinImport:off -- This eval CLI reads a private configuration file or invokes Python's TOML parser.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
);
/** An explicit private config is process-local; otherwise reuse the existing Codex proxy provider. */
export const proxyConfig = () => {
  const file = process.env.T3_EVAL_PROXY_CONFIG;
  if (file !== undefined) {
    const config = decodeProxyConfig(JSON.parse(NodeFS.readFileSync(file, "utf8")));
    return { ...config, url: config.url.replace(/\/+$/u, "") };
  }
  return decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        process.env.T3_EVAL_PYTHON ?? "python3",
        [
          "-c",
          `
import json, os, pathlib, tomllib
home = pathlib.Path.home() / '.codex'
p = tomllib.loads((home / 'config.toml').read_text())['model_providers']['vibeproxy']
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ[p['env_key']] if p.get('env_key') else p.get('experimental_bearer_token')
if not key and p.get('requires_openai_auth'): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
};
