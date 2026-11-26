// lint-staged's 8191-character Windows budget ignores cmd.exe escaping and the .cmd shim, so a
// large commit (an upstream merge) overflows cmd.exe: "The command line is too long". lint-staged
// does not split a function task's commands, so this does, within cmd.exe's limit everywhere.

// cmd.exe's line limit, less its wrapper, the shim's path and the node and script paths it adds.
export const STAGED_COMMAND_BUDGET = 8191 - 1024;

/** Quotes plus a caret before every character: the most cross-spawn adds for a `.cmd` shim. */
export const escapedArgumentLength = (argument: string): number => 2 * argument.length + 6;

const quoted = (file: string) => `"${file}"`;

/**
 * Every command over every file, as sequential commands: all of the first command's chunks run
 * before the second command starts, so lint still reads formatted files. Each command line stays
 * within `budget` once escaped; a single file longer than that gets a command of its own.
 */
export function chunkStagedCommands(
  commands: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  budget: number = STAGED_COMMAND_BUDGET,
): string[] {
  const result: string[] = [];
  for (const command of commands) {
    let chunk: string[] = [];
    let length = escapedArgumentLength(command);
    for (const file of files) {
      const added = 1 + escapedArgumentLength(file);
      if (chunk.length > 0 && length + added > budget) {
        result.push(`${command} ${chunk.map(quoted).join(" ")}`);
        chunk = [];
        length = escapedArgumentLength(command);
      }
      chunk.push(file);
      length += added;
    }
    if (chunk.length > 0) result.push(`${command} ${chunk.map(quoted).join(" ")}`);
  }
  return result;
}
