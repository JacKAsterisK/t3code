import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, FleetRoster } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readFleetJson, writeFleetRoster } from "./FleetFiles.ts";

it.layer(NodeServices.layer)("fleet roster files", (it) => {
  it.effect(
    "preserves the previous roster on invalid edits and atomically publishes a valid replacement",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-roster-test-" });
        const file = path.join(directory, "roster.json");
        yield* writeFleetRoster(file, { version: 1, machines: [] });
        yield* writeFleetRoster(file, {
          version: 1,
          machines: [],
          credential: "synthetic-secret",
        }).pipe(Effect.flip);
        assert.deepEqual(yield* readFleetJson(file, FleetRoster), { version: 1, machines: [] });
        const next = {
          version: 1 as const,
          machines: [
            {
              machineId: "alpha",
              environmentId: EnvironmentId.make("environment:alpha"),
              label: "Alpha",
              origin: "https://alpha.example.test",
              enabled: true,
            },
          ],
        };
        yield* writeFleetRoster(file, next);
        assert.deepEqual(yield* readFleetJson(file, FleetRoster), next);
        assert.deepEqual(yield* fs.readDirectory(directory), ["roster.json"]);
      }),
  );

  it.effect("rejects duplicate JSON members and bounded-file violations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-roster-test-" });
      const file = path.join(directory, "roster.json");
      for (const raw of ['{"version":1,"version":1,"machines":[]}', " ".repeat(1024 * 1024 + 1)]) {
        yield* fs.writeFileString(file, raw);
        yield* readFleetJson(file, FleetRoster).pipe(Effect.flip);
      }
    }),
  );
});
