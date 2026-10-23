import { describe, expect, it } from "vite-plus/test";
import {
  executeStageAcceptance,
  stageAcceptanceCommands,
  type AcceptanceCommand,
} from "./accept-stage-locks.ts";

const commands = () =>
  stageAcceptanceCommands({
    workRoot: "C:\\LANBuild\\acceptance",
    node: "C:\\LANBuild\\tools\\node\\node.exe",
    pnpm: "C:\\LANBuild\\tools\\pnpm\\pnpm.exe",
    systemRoot: "C:\\Windows",
  });
function fixture() {
  const plan = commands();
  const called: AcceptanceCommand[] = [];
  let verifications = 0;
  return {
    called,
    verifications: () => verifications,
    input: {
      commands: plan,
      nodeVersion: "26.12.1",
      pnpmVersion: "12.14.0",
      verifyUnchanged: async () => {
        verifications++;
      },
      run: async (command: AcceptanceCommand) => {
        called.push(command);
        return command === plan.nodeVersion
          ? "v26.12.1\n"
          : command === plan.pnpmVersion
            ? "12.14.0\n"
            : "";
      },
    },
  };
}

describe("pinned production lock acceptance", () => {
  it("uses explicit Node/pnpm with offline frozen resolution and no lifecycle/config inheritance", () => {
    const plan = commands();
    for (const { command } of plan.stages) {
      expect(command.executable).toBe("C:\\LANBuild\\tools\\pnpm\\pnpm.exe");
      expect(command.args[0]).toBe("install");
      expect(command.args).toEqual(
        expect.arrayContaining([
          "--lockfile-only",
          "--offline",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--config.manage-package-manager-versions=false",
        ]),
      );
      expect(command.env).not.toHaveProperty("NODE_OPTIONS");
      expect(command.env).not.toHaveProperty("NPM_TOKEN");
      expect(command.env.PATH).toBe("C:\\LANBuild\\tools\\node");
      expect(command.env.npm_config_userconfig).toBe("C:\\LANBuild\\acceptance\\empty.npmrc");
      expect(command.args).toContain(
        "--config.cache-dir=C:\\LANBuild\\acceptance\\pnpm-store\\metadata-cache",
      );
    }
  });

  it("records acceptance only after both stages and unchanged-input verification", async () => {
    const test = fixture();
    expect(await executeStageAcceptance(test.input)).toMatchObject({
      pinnedPackageManagerAcceptance: "passed",
      stages: ["desktop", "server"],
      lifecycleScriptsExecuted: false,
      nativeBuildIsolationProven: false,
      releaseBuildExecuted: false,
    });
    expect(test.called).toHaveLength(4);
    expect(test.verifications()).toBe(5);
  });

  it.each(["nodeVersion", "pnpmVersion"] as const)(
    "refuses a mismatched %s before stage execution",
    async (version) => {
      const test = fixture();
      test.input[version] = "1.0.0";
      await expect(executeStageAcceptance(test.input)).rejects.toThrow(/different version/u);
      expect(test.called.every((command) => command.args.at(-1) === "--version")).toBe(true);
    },
  );

  it("does not start a child when input verification fails", async () => {
    const test = fixture();
    test.input.verifyUnchanged = async () => {
      throw new Error("toolchain changed");
    };
    await expect(executeStageAcceptance(test.input)).rejects.toThrow("toolchain changed");
    expect(test.called).toEqual([]);
  });

  it("does not execute the next stage after a rewritten lock", async () => {
    const test = fixture();
    test.input.verifyUnchanged = async () => {
      if (test.called.length === 3) throw new Error("lock changed");
    };
    await expect(executeStageAcceptance(test.input)).rejects.toThrow("lock changed");
    expect(test.called).toHaveLength(3);
  });

  it("refuses missing offline metadata without retrying or weakening flags", async () => {
    const test = fixture();
    const run = test.input.run;
    test.input.run = async (command) => {
      const result = await run(command);
      if (command.args.includes("install")) throw new Error("ERR_PNPM_NO_OFFLINE_META");
      return result;
    };
    await expect(executeStageAcceptance(test.input)).rejects.toThrow("ERR_PNPM_NO_OFFLINE_META");
    expect(test.called).toHaveLength(3);
  });
});
