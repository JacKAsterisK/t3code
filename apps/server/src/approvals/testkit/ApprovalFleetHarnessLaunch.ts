import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Config from "../../config.ts";
import * as Launch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Folders from "../../project/ManagedProjectFolders.ts";
import * as Clones from "../../project/ProjectCloneTracker.ts";
import * as Setup from "../../project/ProjectSetupScriptRunner.ts";
import * as SetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as Terminal from "../../terminal/Manager.ts";
import * as Git from "../../git/GitWorkflowService.ts";
import * as GitDriver from "../../vcs/GitVcsDriver.ts";
import * as Providers from "../../provider/ProviderRegistry.ts";
import * as Document from "../../provider/DocumentText.ts";
import * as Repositories from "../../sourceControl/SourceControlRepositoryService.ts";
import * as Text from "../../textGeneration/TextGeneration.ts";
import { instanceId, type FleetEnvironment } from "./ApprovalFleetHarnessEnvironment.ts";

export const projectId = ProjectId.make("approval-fleet-launch-project");
export const layer = (env: FleetEnvironment) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const project = {
        id: projectId,
        title: "Fleet launch probe",
        workspaceRoot: config.baseDir,
        repositoryIdentity: null,
        faviconPath: null,
        defaultModelSelection: { instanceId, model: "gpt-5.4" },
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      };
      const external = Layer.mergeAll(
        SetupTracker.layer,
        Layer.mock(Projects.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: config.baseDir,
          isScratchProject: () => Effect.succeed(false),
          folderForThread: () => Effect.succeedNone,
        }),
        Layer.mock(Clones.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(Setup.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" }),
        }),
        Layer.mock(Terminal.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(Git.GitWorkflowService)({}),
        Layer.mock(GitDriver.GitVcsDriver)({}),
        Layer.mock(Providers.ProviderRegistry)({}),
        Layer.mock(Repositories.SourceControlRepositoryService)({}),
        Layer.mock(Text.TextGeneration)({}),
        Document.layer,
      );
      return Launch.layer.pipe(Layer.provideMerge(external), Layer.provideMerge(Threads.layer));
    }),
  ).pipe(Layer.provide(Layer.succeedContext(env.context)));
