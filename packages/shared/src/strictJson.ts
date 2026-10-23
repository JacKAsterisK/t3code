export function strictJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const tokens =
    text.match(
      /"(?:[^"\\]|\\.)*"|(?:\{|\}|\[|\]|:|,)|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu,
    ) ?? [];
  let index = 0;
  const walk = (): void => {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[index] !== "}") {
        const key: unknown = JSON.parse(tokens[index++] ?? "");
        if (typeof key !== "string" || keys.has(key.toLowerCase()))
          (() => {
            throw new Error("Duplicate JSON member.");
          })();
        keys.add(key.toLowerCase());
        index++;
        walk();
        if (tokens[index] !== ",") break;
        index++;
      }
      index++;
    } else if (token === "[") {
      while (tokens[index] !== "]") {
        walk();
        if (tokens[index] !== ",") break;
        index++;
      }
      index++;
    }
  };
  walk();
  return parsed;
}
