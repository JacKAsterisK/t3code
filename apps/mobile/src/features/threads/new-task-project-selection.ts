import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { repositoryGroupingKeyOf, type EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" }
  | { readonly kind: "dismiss" };

/**
 * The copy of a project a new thread starts in: the preferred environment's, then the
 * representative. A connected copy wins over a disconnected one.
 */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): EnvironmentProject {
  const rank = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.representative ? 1 : 2;
  const ordered = [...scope.projects].sort((left, right) => rank(left) - rank(right));
  return (
    ordered.find((project) => connectedEnvironmentIds.has(project.environmentId)) ??
    ordered[0] ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, which supplies no useful basename.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // Use weaker signals only when identity is unknown; different known repositories never match by basename or title.
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  draft: {
    readonly incomingShareId: string | undefined;
    /** The draft's first project picker closed and the draft is showing again. */
    readonly pickerClosed: boolean;
  },
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }
  // A share draft holds content the user sent here, so cancelling the picker must not drop it.
  if (draft.pickerClosed && selectedProjectKey === null && draft.incomingShareId === undefined) {
    return { kind: "dismiss" };
  }

  const onlyScope =
    draft.incomingShareId !== undefined && projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope ? { kind: "select", project: onlyScope.representative } : { kind: "pick" };
}

type ProjectRef = { readonly environmentId: string; readonly projectId: string };

/**
 * The project a machine group's new task opens on: the last project used, when it
 * is on that machine, then the machine's most recently active project, then its first.
 * Named projects win over the machine's scratch workspace.
 */
export function resolveMachineNewTaskProject(options: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "updatedAt">
  >;
  readonly lastProject: ProjectRef | undefined;
  readonly scratchWorkspaceRoot: string | null | undefined;
}): EnvironmentProject | null {
  const onMachine = options.projects.filter(
    (project) => project.environmentId === options.environmentId,
  );
  const named = onMachine.filter(
    (project) => !isScratchProject(project, options.scratchWorkspaceRoot),
  );
  const projects = named.length > 0 ? named : onMachine;
  const last = projects.find(
    (project) =>
      project.environmentId === options.lastProject?.environmentId &&
      project.id === options.lastProject.projectId,
  );
  if (last) return last;
  let latest: { readonly project: EnvironmentProject; readonly at: string } | null = null;
  for (const thread of options.threads) {
    if (thread.environmentId !== options.environmentId) continue;
    if (latest !== null && thread.updatedAt <= latest.at) continue;
    const project = projects.find((candidate) => candidate.id === thread.projectId);
    if (project) latest = { project, at: thread.updatedAt };
  }
  return latest?.project ?? projects[0] ?? null;
}

export function newTaskDestination(options: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly requestId: string;
  readonly useLastProject: boolean | undefined;
  readonly currentProject: ProjectRef | undefined;
  readonly lastProject: ProjectRef | undefined;
}) {
  const find = (ref: ProjectRef | undefined) =>
    ref &&
    options.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    );
  const project =
    options.useLastProject === false
      ? undefined
      : (find(options.currentProject) ?? find(options.lastProject));
  return project
    ? {
        draft: {
          requestId: options.requestId,
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        },
      }
    : { draft: { requestId: options.requestId } };
}
