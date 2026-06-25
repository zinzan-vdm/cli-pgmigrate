import type { Types } from "./Types.js";

/** Advisory lock salt (mirrors golang-migrate's constant) */
export const ADVISORY_LOCK_SALT = 1486364155;

/** Default tracking table name */
export const DEFAULT_TABLE_NAME = "_migrations";

/** Default source directory */
export const DEFAULT_SOURCE = ".";

/** Default config path (relative to source dir) */
export const DEFAULT_CONFIG = "config.yml";

/** Print usage information to stdout */
export function printUsage(): void {
  console.log(`pgmigrate — PostgreSQL migration tool

USAGE
  pgmigrate [options] <database_uri>

REQUIRED
  --to <version>    Target version (format: YYYYMMDDTHHMM-SS)

OPTIONS
  --from <version>  Current version. Default: read from tracking table.
                    On a fresh DB with no tracking table, applies all
                    versions from the first one up to --to.
  --source <dir>    Directory containing version subdirectories. Default: .
  --config <file>   Config YAML. Default: <source>/config.yml
  --force           Set version in tracking table without running SQL.
                    For dirty-state recovery after manual intervention.
  --help, -h        Show this help

DIRECTION
  Forward (--from < --to)    runs up.sql   files
  Backward (--from > --to)   runs down.sql files

EXAMPLES
  # Apply all pending versions up to 01 (resolves --from from tracking table)
  pgmigrate --to 20260612T0015-01 postgres://localhost/mydb

  # Explicit forward migration
  pgmigrate --from 20260612T0015-00 --to 20260612T0015-01 postgres://localhost/mydb

  # Rollback one version
  pgmigrate --from 20260612T0015-01 --to 20260612T0015-00 postgres://localhost/mydb

  # Custom source tree
  pgmigrate --source ./db/migrations --to 20260612T0015-01 postgres://localhost/mydb

  # Force recovery after a failed migration (no SQL executed)
  pgmigrate --to 20260612T0015-01 --force postgres://localhost/mydb

SOURCE STRUCTURE
  <source>/
    20260612T0015-00/
      up.sql       # Forward migration (required)
      down.sql     # Rollback (optional)
    20260612T0015-01/
      up.sql
      down.sql

CONFIG (<source>/config.yml)
  tracking:
    table-name: _migrations    # default
`);
}

/**
 * Parse raw argv into CLIOptions.
 * Returns a Result — [null, Error] on parse failure with a human-readable message.
 */
export function parseArgs(argv: string[]): Types.Result<Types.CLIOptions> {
  const args = argv.slice(2); // skip bun/shebang + script path
  const opts: Partial<Types.CLIOptions> = {
    source: DEFAULT_SOURCE,
    config: "",
    force: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--to") {
      i++;
      const val = args[i];
      if (!val) return [null, new Error("--to requires a version argument")];
      if (!/^\d{8}T\d{4}-\d{2}$/.test(val)) {
        return [
          null,
          new Error(
            `Invalid version format: '${val}'. Expected YYYYMMDDTHHMM-SS (e.g. 20260612T0015-00)`,
          ),
        ];
      }
      opts.to = val;
    } else if (arg === "--from") {
      i++;
      const val = args[i];
      if (!val) return [null, new Error("--from requires a version argument")];
      if (!/^\d{8}T\d{4}-\d{2}$/.test(val)) {
        return [
          null,
          new Error(
            `Invalid version format: '${val}'. Expected YYYYMMDDTHHMM-SS (e.g. 20260612T0015-00)`,
          ),
        ];
      }
      opts.from = val;
    } else if (arg === "--source") {
      i++;
      const val = args[i];
      if (!val) return [null, new Error("--source requires a directory path")];
      opts.source = val;
    } else if (arg === "--config") {
      i++;
      const val = args[i];
      if (!val) return [null, new Error("--config requires a file path")];
      opts.config = val;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      return [null, new Error("HELP")];
    } else if (arg.startsWith("-")) {
      return [null, new Error(`Unknown option: ${arg}`)];
    } else {
      // Positional argument — database URI
      if (opts.databaseUri) {
        return [
          null,
          new Error(
            `Unexpected argument: ${arg}. Database URI already provided as '${opts.databaseUri}'`,
          ),
        ];
      }
      opts.databaseUri = arg;
    }
    i++;
  }

  // Validate required
  if (!opts.to) return [null, new Error("--to is required")];
  if (!opts.databaseUri)
    return [
      null,
      new Error("Database URI is required as the last positional argument"),
    ];

  // Resolve config path: if --config provided, use it; otherwise default to $source/config.yml
  if (!opts.config) {
    opts.config = `${opts.source}/${DEFAULT_CONFIG}`;
  }

  return [opts as Types.CLIOptions, undefined];
}

/**
 * Validate that --from and --to are in the correct temporal order
 * for a forward migration (from < to).
 */
export function isForward(from: Types.Version, to: Types.Version): boolean {
  return from < to;
}

/**
 * Validate that --from and --to are in the correct temporal order
 * for a backward migration (from > to).
 */
export function isBackward(from: Types.Version, to: Types.Version): boolean {
  return from > to;
}

/** Check if two versions are equal */
export function sameVersion(a: Types.Version, b: Types.Version): boolean {
  return a === b;
}
