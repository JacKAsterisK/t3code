// @effect-diagnostics nodeBuiltinImport:off -- Read-only enumeration of local check inputs; dependency and directory links are never traversed.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const skippedDirectories = new Set([
  ".git",
  "node_modules",
  ".repos",
  ".pnpm-store",
  ".vite-plus",
  ".turbo",
  ".t3",
  "dist",
  "dist-exe",
  "dist-electron",
  "build",
  "release",
  "release-mock",
  ".logs",
  ".android-cache",
  ".electron-runtime",
  ".showcase",
  ".playwright",
  "playwright-report",
  "__screenshots__",
  ".plans",
  ".alchemy",
  ".vercel",
  ".gstack",
]);

export function generatedCheckInputs(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, generated: boolean) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, directory), {
      withFileTypes: true,
    })) {
      const relative = directory ? directory + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (
          skippedDirectories.has(entry.name) ||
          (entry.name === "target" && directory.startsWith("native/"))
        )
          continue;
        walk(relative, generated || entry.name === ".generated" || entry.name === ".astro");
      } else if (generated || entry.name.endsWith(".d.ts") || entry.name.startsWith(".env")) {
        // A linked env file can affect checks; directory junctions must never recurse.
        if (
          entry.isFile() ||
          (entry.isSymbolicLink() && NodeFS.statSync(NodePath.join(root, relative)).isFile())
        )
          files.push(relative);
      }
    }
  };
  walk("", false);
  return files.sort();
}
