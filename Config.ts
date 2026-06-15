import YAML from "yaml";
import { readFile as fsReadFile } from "node:fs/promises";
import type { Types } from "./Types.js";
import { DEFAULT_TABLE_NAME } from "./CLI.js";

export namespace Config {
  /**
   * Load and parse the migration config YAML file.
   * If the file does not exist, returns default config silently.
   */
  export async function load(
    configPath: string,
    /* istanbul ignore next */
    deps: load.Dependencies = load.DefaultDependencies,
  ): Promise<Types.Result<Types.Config>> {
    let raw: string | null;
    try {
      const content = await deps.fs.readFile(configPath);
      raw = content;
    } catch (_err) {
      // File not found — return defaults
      return [{ tracking: { tableName: DEFAULT_TABLE_NAME } }, undefined];
    }

    if (!raw || raw.trim().length === 0) {
      return [{ tracking: { tableName: DEFAULT_TABLE_NAME } }, undefined];
    }

    const [parsed, parseErr] = deps.parser.parse<{
      tracking?: {
        "table-name"?: string;
      };
    }>(raw);

    if (parseErr) {
      return [
        null,
        new Error(
          `Failed to parse config '${configPath}': ${parseErr.message}`,
        ),
      ];
    }

    console.log({ configPath, raw, parsed });

    const tableName: string =
      parsed?.tracking?.["table-name"] ?? DEFAULT_TABLE_NAME;

    return [{ tracking: { tableName } }, undefined];
  }

  export namespace load {
    export type Dependencies = {
      fs: { readFile: (path: string) => Promise<string> };
      parser: { parse: <T>(input: string) => Types.Result<T> };
    };

    /* istanbul ignore next */
    export const DefaultDependencies: Dependencies = {
      fs: {
        readFile: async (path: string) => {
          const buf = await fsReadFile(path, { encoding: "utf-8" });
          return buf as string;
        },
      },
      parser: {
        parse: <T>(input: string): Types.Result<T> => {
          try {
            const doc = YAML.parse(input);
            return [doc, undefined];
          } catch (err) {
            return [null, err instanceof Error ? err : new Error(String(err))];
          }
        },
      },
    };
  }
}
