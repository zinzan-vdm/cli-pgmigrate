import { describe, it, expect } from "bun:test";
import { Config } from "./Config.js";
import { DEFAULT_TABLE_NAME } from "./CLI.js";
import type { Types } from "./Types.js";

describe("Config.load", () => {
  it("should return defaults when file does not exist", async () => {
    const mockDeps: Config.load.Dependencies = {
      fs: {
        readFile: async (_path: string) => {
          throw new Error("ENOENT");
        },
      },
      parser: {
        parse: <T>(_input: string): Types.Result<T> =>
          [{} as never, undefined] as never as Types.Result<T>,
      },
    };

    const [cfg, err] = await Config.load("/nonexistent/config.yml", mockDeps);
    expect(err).toBeUndefined();
    expect(cfg!.tracking.tableName).toBe(DEFAULT_TABLE_NAME);
  });

  it("should return defaults when file is empty", async () => {
    const mockDeps: Config.load.Dependencies = {
      fs: {
        readFile: async (_path: string) => "",
      },
      parser: {
        parse: <T>(_input: string): Types.Result<T> =>
          [{} as never, undefined] as never as Types.Result<T>,
      },
    };

    const [cfg, err] = await Config.load("/tmp/empty.yml", mockDeps);
    expect(err).toBeUndefined();
    expect(cfg!.tracking.tableName).toBe(DEFAULT_TABLE_NAME);
  });

  it("should return defaults when file is whitespace-only", async () => {
    const mockDeps: Config.load.Dependencies = {
      fs: {
        readFile: async (_path: string) => "   \n  \n  ",
      },
      parser: {
        parse: <T>(_input: string): Types.Result<T> =>
          [{} as never, undefined] as never as Types.Result<T>,
      },
    };

    const [cfg, err] = await Config.load("/tmp/whitespace.yml", mockDeps);
    expect(err).toBeUndefined();
    expect(cfg!.tracking.tableName).toBe(DEFAULT_TABLE_NAME);
  });

  it("should parse config file and extract table name", async () => {
    const mockDeps: Config.load.Dependencies = {
      fs: {
        readFile: async (_path: string) =>
          "tracking:\n  table-name: my_migrations\n",
      },
      parser: {
        parse: <T>(input: string): Types.Result<T> => {
          if (input.includes("table-name")) {
            return [
              { tracking: { "table-name": "my_migrations" } } as never,
              undefined,
            ] as never as Types.Result<T>;
          }
          return [
            { tracking: { "table-name": DEFAULT_TABLE_NAME } } as never,
            undefined,
          ] as never as Types.Result<T>;
        },
      },
    };

    const [cfg, err] = await Config.load("/tmp/test.yml", mockDeps);
    expect(err).toBeUndefined();
    expect(cfg!.tracking.tableName).toBe("my_migrations");
  });

  it("should use default when config has no tracking section", async () => {
    const mockDeps: Config.load.Dependencies = {
      fs: {
        readFile: async (_path: string) => "other: true\n",
      },
      parser: {
        parse: <T>(_input: string): Types.Result<T> =>
          [{ other: true } as never, undefined] as never as Types.Result<T>,
      },
    };

    const [cfg, err] = await Config.load("/tmp/other.yml", mockDeps);
    expect(err).toBeUndefined();
    expect(cfg!.tracking.tableName).toBe(DEFAULT_TABLE_NAME);
  });

  it("should return error when YAML parsing fails", async () => {
    const mockDeps: Config.load.Dependencies = {
      fs: {
        readFile: async (_path: string) => "bad yaml: [\n",
      },
      parser: {
        parse: <T>(_input: string): Types.Result<T> =>
          [
            null,
            new Error("Parse error at line 1"),
          ] as never as Types.Result<T>,
      },
    };

    const [cfg, err] = await Config.load("/tmp/bad.yml", mockDeps);
    expect(cfg).toBeNull();
    expect(err!.message).toContain("Failed to parse config");
  });
});
