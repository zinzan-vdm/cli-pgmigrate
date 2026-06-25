/// <reference types="./postgres.d.ts" />
import postgres from "postgres";
import type { Types } from "./Types.js";
import { parseArgs, isForward, isBackward, sameVersion } from "./CLI.js";
import { Config } from "./Config.js";
import { Migrator } from "./Migrator.js";

/**
 * CLI entry point for the migrate tool.
 *
 * Usage: migrate [options] <database_uri>
 *
 * Parses arguments, resolves config, connects to the database,
 * and runs the appropriate migration (forward, backward, or force).
 */
async function main(argv: string[]): Promise<number> {
  // Parse arguments
  const [opts, parseErr] = parseArgs(argv);
  if (parseErr) {
    if (parseErr.message === "HELP") return 0;
    console.error(parseErr.message);
    console.error(
      "Usage: pgmigrate [--to <version>] [--from <version>] [--source <dir>] [--config <file>] [--force] <database_uri>",
    );
    return 1;
  }

  // Load config
  const [config, configErr] = await Config.load(opts.config);
  if (configErr) {
    console.error(`Config error: ${configErr.message}`);
    return 1;
  }

  // Connect to database
  let sql: ReturnType<typeof postgres>;
  try {
    sql = postgres(opts.databaseUri);
    // Verify connectivity
    await sql`SELECT 1`;
  } catch (err) {
    console.error(
      `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  try {
    const tableName = config.tracking.tableName;

    // Extract database name from URI for advisory lock scoping
    const dbName = extractDbName(opts.databaseUri);

    if (opts.force) {
      // golang-migrate style: just set the version, no SQL executed
      console.log(`Forcing version to '${opts.to}'...`);
      const [_, forceErr] = await Migrator.force({
        sql,
        tableName,
        dbName,
        to: opts.to,
      });
      if (forceErr) {
        console.error(`Force failed: ${forceErr.message}`);
        return 1;
      }
      console.log(`Version forced to '${opts.to}'. Database marked clean.`);
      return 0;
    }

    // Resolve --from from tracking table if not provided
    let fromVersion: Types.Version;
    if (opts.from) {
      fromVersion = opts.from;
    } else {
      // Don't need advisory lock just for reading state
      const [state, stateErr] = await readState(sql, tableName);
      if (stateErr) {
        console.error(`Failed to read current state: ${stateErr.message}`);
        return 1;
      }
      if (state.version === null) {
        // Fresh database — find the first version directory
        const [versions, listErr] = await Migrator.listVersions(opts.source);
        if (listErr) {
          console.error(`Failed to list versions: ${listErr.message}`);
          return 1;
        }
        if (versions.length === 0) {
          console.error("No migration versions found in source directory.");
          return 1;
        }
        // Set from to just before the first version (as if no migrations applied)
        fromVersion = getVersionBefore(versions[0]!.version);
        console.log(
          `Fresh database. Starting from version '${fromVersion}' (before first migration).`,
        );
      } else {
        fromVersion = state.version;
        console.log(
          `Current database version: '${fromVersion}'${state.dirty ? " [DIRTY]" : ""}`,
        );
      }
    }

    if (sameVersion(fromVersion, opts.to)) {
      console.log(
        `Database is already at version '${opts.to}'. Nothing to do.`,
      );
      return 0;
    }

    if (isForward(fromVersion, opts.to)) {
      console.log(`Forward migrating: '${fromVersion}' → '${opts.to}'...`);
      const [_, migrateErr] = await Migrator.forward({
        sql,
        source: opts.source,
        tableName,
        dbName,
        from: fromVersion,
        to: opts.to,
      });
      if (migrateErr) {
        console.error(`Migration failed: ${migrateErr.message}`);
        return 1;
      }
      console.log(`Successfully migrated to version '${opts.to}'.`);
      return 0;
    }

    if (isBackward(fromVersion, opts.to)) {
      console.log(`Rolling back: '${fromVersion}' → '${opts.to}'...`);
      const [_, rollbackErr] = await Migrator.backward({
        sql,
        source: opts.source,
        tableName,
        dbName,
        from: fromVersion,
        to: opts.to,
      });
      if (rollbackErr) {
        console.error(`Rollback failed: ${rollbackErr.message}`);
        return 1;
      }
      console.log(`Successfully rolled back to version '${opts.to}'.`);
      return 0;
    }

    console.error(
      `Unexpected version ordering: from '${fromVersion}', to '${opts.to}'`,
    );
    return 1;
  } finally {
    await sql.end();
  }
}

/**
 * Read the current state from the tracking table directly (no lock).
 * Used for initial --from resolution before the migration flow starts.
 */
async function readState(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<Types.Result<Types.TrackState>> {
  try {
    // Check if table exists first
    const tableCheck = await sql`
			SELECT COUNT(1) AS cnt
			FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = ${tableName}
			LIMIT 1
		`;
    if (tableCheck.length === 0 || Number(tableCheck[0]!["cnt"]) === 0) {
      return [{ version: null, dirty: false }, undefined];
    }

    const rows = await sql`
			SELECT version, dirty
			FROM ${sql(tableName)}
			ORDER BY applied_at DESC
			LIMIT 1
		`;
    if (rows.length === 0) {
      return [{ version: null, dirty: false }, undefined];
    }
    const row = rows[0] as { version: string; dirty: boolean };
    return [{ version: row.version, dirty: row.dirty }, undefined];
  } catch (err) {
    return [
      null,
      new Error(
        `Failed to read state: ${err instanceof Error ? err.message : String(err)}`,
      ),
    ];
  }
}

/**
 * Extract the database name from a PostgreSQL connection URI.
 * Falls back to 'migration' if it can't be determined.
 */
function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    const dbName = url.pathname.replace(/^\//, "");
    return dbName || "migration";
  } catch {
    return "migration";
  }
}

/**
 * Get a version string that sorts before the given version.
 * Used as the "before first version" placeholder for fresh databases.
 */
function getVersionBefore(_version: Types.Version): Types.Version {
  // Sentinel that sorts before any real version (which all start with the current year, e.g. 2026...)
  return `00000000T0000-00`;
}

// Run main and exit with the appropriate code
main(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
