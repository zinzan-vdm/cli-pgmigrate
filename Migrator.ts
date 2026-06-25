/// <reference types="./postgres.d.ts" />
import { readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import type { Types } from "./Types.js";
import { Track } from "./Track.js";

export namespace Migrator {
  export type ApplyOpts = {
    sql: Sql;
    source: string;
    tableName: string;
    dbName: string;
    from: Types.Version;
    to: Types.Version;
  };

  export type ForceOpts = {
    sql: Sql;
    tableName: string;
    dbName: string;
    to: Types.Version;
  };

  /**
   * Forward migration: apply up.sql from `from` → `to`.
   *
   * Follows the dirty-flag protocol:
   *   1. Advisory lock
   *   2. Ensure tracking table
   *   3. Abort if dirty
   *   4. For each version: INSERT dirty=true → run SQL → INSERT dirty=false
   *   5. Release lock
   */
  export async function forward(opts: ApplyOpts): Promise<Types.Result<void>> {
    const { sql, source, tableName, dbName, from, to } = opts;

    const [_a, lockErr] = await Track.lock(sql, dbName);
    if (lockErr) return [null, lockErr];

    try {
      const [_b, ensureErr] = await Track.ensureTable(sql, tableName);
      if (ensureErr) return [null, ensureErr];

      const [state, stateErr] = await Track.getState(sql, tableName);
      if (stateErr) return [null, stateErr];
      if (state.dirty) {
        return [
          null,
          new Error(
            `Database is dirty at version '${state.version}'. Use --force to recover after fixing the issue.`,
          ),
        ];
      }

      const [versions, listErr] = await listVersions(source);
      if (listErr) return [null, listErr];

      const targets = versions.filter(
        (v) => v.version > from && v.version <= to,
      );
      if (targets.length === 0) {
        return [
          null,
          new Error(`No versions between '${from}' and '${to}' to apply.`),
        ];
      }

      for (const ver of targets) {
        const [_c, dirtyErr] = await Track.setVersion(
          sql,
          tableName,
          ver.version,
          true,
        );
        if (dirtyErr) return [null, dirtyErr];

        const [sqlText, readErr] = await readFileContent(ver.upPath);
        if (readErr) return [null, readErr];

        try {
          await sql.unsafe(sqlText);
        } catch (execErr) {
          return [
            null,
            new Error(
              `Migration failed at '${ver.version}' (up.sql). Dirty flag left set. Fix manually, then use --force to recover. ` +
                `Error: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
            ),
          ];
        }

        const [_d, cleanErr] = await Track.setVersion(
          sql,
          tableName,
          ver.version,
          false,
        );
        if (cleanErr) return [null, cleanErr];
      }

      return [undefined, undefined];
    } finally {
      await Track.unlock(sql, dbName);
    }
  }

  /**
   * Backward migration: apply down.sql from `from` → `to`.
   *
   * Each rollback step inserts a dirty marker for the version being rolled
   * back, runs down.sql, then inserts a clean marker for the version that
   * results (the version just before the one rolled back in the sorted list,
   * or `to` for the last step).
   */
  export async function backward(opts: ApplyOpts): Promise<Types.Result<void>> {
    const { sql, source, tableName, dbName, from, to } = opts;

    const [_e, lockErr] = await Track.lock(sql, dbName);
    if (lockErr) return [null, lockErr];

    try {
      const [_f, ensureErr] = await Track.ensureTable(sql, tableName);
      if (ensureErr) return [null, ensureErr];

      const [state, stateErr] = await Track.getState(sql, tableName);
      if (stateErr) return [null, stateErr];
      if (state.dirty) {
        return [
          null,
          new Error(
            `Database is dirty at version '${state.version}'. Use --force to recover.`,
          ),
        ];
      }

      const [allVersions, listErr] = await listVersions(source);
      if (listErr) return [null, listErr];

      // versions to roll back: between to (exclusive) and from (inclusive), newest first
      const targets = allVersions
        .filter((v) => v.version > to && v.version <= from)
        .reverse();

      if (targets.length === 0) {
        return [
          null,
          new Error(`No versions to roll back between '${from}' and '${to}'.`),
        ];
      }

      for (const ver of targets) {
        const [_g, dirtyErr] = await Track.setVersion(
          sql,
          tableName,
          ver.version,
          true,
        );
        if (dirtyErr) return [null, dirtyErr];

        if (!ver.downPath) {
          return [
            null,
            new Error(
              `Version '${ver.version}' is missing down.sql — cannot roll back.`,
            ),
          ];
        }

        const [sqlText, readErr] = await readFileContent(ver.downPath);
        if (readErr) return [null, readErr];

        try {
          await sql.unsafe(sqlText);
        } catch (execErr) {
          return [
            null,
            new Error(
              `Rollback failed at '${ver.version}' (down.sql). Dirty flag left set. Fix manually, then use --force to recover. ` +
                `Error: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
            ),
          ];
        }

        // After rolling back, the current version is the one just before ver
        const sortedIdx = allVersions.indexOf(ver);
        const newVersion =
          sortedIdx > 0 ? allVersions[sortedIdx - 1]!.version : "";

        const [_h, cleanErr] = await Track.setVersion(
          sql,
          tableName,
          newVersion,
          false,
        );
        if (cleanErr) return [null, cleanErr];
      }

      return [undefined, undefined];
    } finally {
      await Track.unlock(sql, dbName);
    }
  }

  /**
   * Force-set the tracking table to a version without executing SQL.
   * Mirrors golang-migrate's `force` — for dirty-state recovery.
   */
  export async function force(opts: ForceOpts): Promise<Types.Result<void>> {
    const { sql, tableName, dbName, to } = opts;

    const [_i, lockErr] = await Track.lock(sql, dbName);
    if (lockErr) return [null, lockErr];

    try {
      const [_j, ensureErr] = await Track.ensureTable(sql, tableName);
      if (ensureErr) return [null, ensureErr];

      const [_k, setErr] = await Track.setVersion(sql, tableName, to, false);
      if (setErr) return [null, setErr];

      return [undefined, undefined];
    } finally {
      await Track.unlock(sql, dbName);
    }
  }

  /**
   * List version directories in `source`, sorted ascending.
   * Each directory must match YYYYMMDDTHHMM-SS and contain at least up.sql.
   */
  export async function listVersions(
    source: string,
  ): Promise<Types.Result<Types.VersionDir[]>> {
    const versionRe = /^\d{8}T\d{4}-\d{2}$/;
    const results: Types.VersionDir[] = [];

    try {
      const entries = await readdir(source, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!versionRe.test(entry.name)) continue;

        const dirPath = join(source, entry.name);
        const upPath = join(dirPath, "up.sql");
        const downPath = join(dirPath, "down.sql");

        let hasUp = false;
        let hasDown = false;
        try {
          hasUp = statSync(upPath).isFile();
        } catch {
          /* ignore */
        }
        try {
          hasDown = statSync(downPath).isFile();
        } catch {
          /* ignore */
        }

        if (!hasUp) {
          return [
            null,
            new Error(`Version directory '${entry.name}' is missing up.sql.`),
          ];
        }

        results.push({
          version: entry.name,
          upPath,
          downPath: hasDown ? downPath : "",
        });
      }

      results.sort((a, b) => a.version.localeCompare(b.version));
      return [results, undefined];
    } catch (err) {
      return [
        null,
        new Error(
          `Failed to read source directory '${source}': ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }

  async function readFileContent(path: string): Promise<Types.Result<string>> {
    try {
      const content = await readFile(path, { encoding: "utf-8" });
      return [content.trim(), undefined];
    } catch (err) {
      return [
        null,
        new Error(
          `Failed to read '${path}': ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }
}
