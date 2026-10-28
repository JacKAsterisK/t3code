import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeHeaderProps } from "./HomeHeader.types";

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentId"
    | "selectedProjectKey"
    | "onEnvironmentChange"
    | "onProjectChange"
  > & {
    /** List padding the scroller bleeds through so pills start where row content does. */
    readonly gutter: number;
  },
) {
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  const { threadGrouping, setThreadGrouping } = useThreadListV2ShelfPreferences();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      <ListFilterMenu
        label={selectedEnvironment?.label ?? "All environments"}
        accessibilityLabel="Filter threads by environment"
        active={selectedEnvironment !== undefined}
        actions={[
          {
            id: "all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state:
              environment.environmentId === props.selectedEnvironmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onEnvironmentChange(null);
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }
        }}
      />
      <ListFilterMenu
        label={selectedProject?.label ?? "All projects"}
        accessibilityLabel="Filter threads by project"
        active={selectedProject !== undefined}
        actions={[
          {
            id: "all",
            title: "All projects",
            state: props.selectedProjectKey === null ? "on" : "off",
          },
          ...props.projects.map((project) => ({
            id: JSON.stringify(project.key),
            title: project.label,
            state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onProjectChange(null);
          else {
            const project = props.projects.find(
              (candidate) => JSON.stringify(candidate.key) === id,
            );
            if (project) props.onProjectChange(project.key);
          }
        }}
      />
      {props.environments.length >= 2 ? (
        <ListFilterMenu
          label={threadGrouping === "machine" ? "By machine" : "No grouping"}
          accessibilityLabel="Group threads"
          active={threadGrouping === "machine"}
          actions={[
            { id: "none", title: "No grouping", state: threadGrouping === "none" ? "on" : "off" },
            {
              id: "machine",
              title: "Group by machine",
              state: threadGrouping === "machine" ? "on" : "off",
            },
          ]}
          onSelect={(id) => setThreadGrouping(id === "machine" ? "machine" : "none")}
        />
      ) : null}
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            props.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
