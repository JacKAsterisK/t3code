import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveMachineNewTaskProject } from "./new-task-project-selection";

/** A machine header's new-task action, or undefined when the machine has no project. */
export function machineNewTaskAction(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}): (() => void) | undefined {
  if (!input.projects.some((project) => project.environmentId === input.environmentId)) {
    return undefined;
  }
  return () => {
    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
    const project = resolveMachineNewTaskProject({
      environmentId: input.environmentId,
      projects: input.projects,
      threads: input.threads,
      lastProject:
        saved?.useLastProjectForNewThreads === false ? undefined : saved?.lastThreadProject,
      scratchWorkspaceRoot: appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(input.environmentId)?.scratchWorkspaceRoot,
    });
    if (project) input.onNewThreadInProject(project);
  };
}
