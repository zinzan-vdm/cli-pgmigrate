# pgmigrate

Standalone PostgreSQL migration tool. Applies versioned `up.sql` / `down.sql` against a PostgreSQL database with dirty-flag safety, advisory locks, and force-recovery.

Built with [Bun](https://bun.sh), compiled to a single binary.

---

## Prerequisites

Pinned versions for reproducible development:

| Tool                                                | Version  | Required | Notes                                  |
| --------------------------------------------------- | -------- | -------- | -------------------------------------- |
| [Bun](https://bun.sh)                               | `1.3.14` | ✅       | Runtime, test runner, compiler         |
| [TypeScript](https://www.typescriptlang.org)        | `5.9.3`  | dev      | Type checking (`bun x tsc`)            |
| [postgres.js](https://github.com/porsager/postgres) | `3.4.8`  | ✅       | PostgreSQL driver                      |
| [js-yaml](https://github.com/nodeca/js-yaml)        | `4.1.0`  | ✅       | Config file parsing                    |
| [ESLint](https://eslint.org)                        | `9.39.2` | dev      | Linting                                |
| [Prettier](https://prettier.io)                     | `3.8.1`  | dev      | Formatting                             |
| [Docker](https://docker.com)                        | `29.3.1` | e2e      | Container runtime for end-to-end tests |
| [PostgreSQL](https://postgresql.org)                | `16`     | e2e      | Target database (any 14+ works)        |
| [just](https://github.com/casey/just)               | `1.40.0` | optional | Task runner (`just test`, `just e2e`)  |

Runtime dependencies (`postgres`, `js-yaml`) are locked in `bun.lock`. Dev tooling is pinned in `package.json`.

---

## Usage

```
pgmigrate [options] <database_uri>
```

| Option             | Default               | Description                           |
| ------------------ | --------------------- | ------------------------------------- |
| `--to <version>`   | —                     | Target version (`YYYYMMDDTHHMM-SS`)   |
| `--from <version>` | tracking table        | Current version                       |
| `--source <dir>`   | `.`                   | Version directory root                |
| `--config <file>`  | `<source>/config.yml` | Config YAML path                      |
| `--force`          | —                     | Set version in tracking table, no SQL |
| `--help`, `-h`     | —                     | Show help                             |

Direction is inferred from `--from` vs `--to`:

- `from < to` → forward, runs `up.sql`
- `from > to` → backward, runs `down.sql`

### Examples

```sh
# Apply all pending migrations (reads from tracking table)
pgmigrate --to 20260612T0015-01 postgres://localhost/mydb

# Forward from a specific version
pgmigrate --from 20260612T0015-00 --to 20260612T0015-01 postgres://localhost/mydb

# Rollback one version
pgmigrate --from 20260612T0015-01 --to 20260612T0015-00 postgres://localhost/mydb

# Custom source directory
pgmigrate --source ./db/migrations --to 20260612T0015-01 postgres://localhost/mydb

# Force recovery after a failed migration
pgmigrate --to 20260612T0015-01 --force postgres://localhost/mydb
```

---

## Source Structure

```
migrations/
├── 20260612T0015-00/
│   ├── up.sql       # forward migration (required)
│   └── down.sql     # rollback (optional)
├── 20260612T0015-01/
│   ├── up.sql
│   └── down.sql
└── 20260612T0030-00/
    └── up.sql
```

Versions sort lexicographically — the timestamp format sorts chronologically.

---

## Config

Optional `config.yml` alongside the source directory:

```yaml
tracking:
  table-name: _migrations # default
```

Missing or empty config falls back to defaults.

---

## How It Works

### Tracking table (append-only log)

```sql
CREATE TABLE _migrations (
    version    text        NOT NULL,
    dirty      boolean     NOT NULL DEFAULT false,
    applied_at timestamptz NOT NULL DEFAULT now()
);
```

Each migration event appends a row. The current state is the latest row by `applied_at`:

```sql
SELECT version, dirty FROM _migrations ORDER BY applied_at DESC LIMIT 1;
```

Example log after a forward migration then rollback:

```
version                 | dirty | applied_at
20260612T0015-00        | f     | 2026-06-12 09:00:00
20260612T0015-01        | t     | 2026-06-12 09:01:00  ← crash
20260612T0015-01        | f     | 2026-06-12 09:02:00  ← after --force
20260612T0015-00        | f     | 2026-06-12 09:03:00  ← rollback
```

No UPDATES, no TRUNCATE — only INSERTs. The history is immutable.

### Migration flow

Each migration step records two events in the log — one before, one after:

```
1. Acquire advisory lock
2. Ensure tracking table exists
3. Read latest row — abort if dirty
4. For each version between from→to:
   a. INSERT (version, dirty=true)     ← attempt marker
   b. Execute SQL file
   c. INSERT (version, dirty=false)    ← completion marker
5. Release advisory lock
```

Crash between 4a and 4c leaves `dirty=true` as the latest row. All future runs are blocked until `--force` recovers. No UPDATES or TRUNCATE — every event is an immutable INSERT.

### Force recovery (`--force`)

Sets version in tracking table without executing any SQL — mirrors golang-migrate's `force VERSION`. Use when:

- A migration failed mid-file and you manually repaired the schema
- The database is dirty and you need to reset the tracking state

```sh
pgmigrate --to 20260612T0015-01 --force postgres://localhost/mydb
# Appends: INSERT (version='20260612T0015-01', dirty=false)
```

### Advisory locks

Uses `pg_advisory_lock` with the lock ID computed as `CRC32(db_name) × 1486364155` (same magic salt as golang-migrate). The lock is held for the entire run and released in a `finally` block. Two concurrent invocations against the same database will serialize.

### Read-only user support

Before creating the tracking table, pgmigrate checks `information_schema.tables` first. If the table already exists, no `CREATE TABLE` is attempted. This supports read-only users who can query state but not create tables.

---

## Build

```sh
bun build --compile ./index.ts --outfile pgmigrate
```

Produces a standalone ~91 MB binary. No runtime dependencies.

### Dev commands

| Command                    | Action        |
| -------------------------- | ------------- |
| `bun test`                 | 52 unit tests |
| `bun x tsc --noEmit`       | Type check    |
| `bun x eslint .`           | Lint          |
| `bun x prettier --check .` | Format check  |

## End-to-end tests

Requires Docker. The e2e suite starts a PostgreSQL container, runs migrations against it with pgmigrate, and asserts the results using the `postgres.js` driver via Bun.

```sh
just e2e
```

Tests cover: forward migration, rollback, version resolution from tracking table, dirty-flag detection, force recovery, and tracking log integrity.

---

## References

- **[golang-migrate/migrate](https://github.com/golang-migrate/migrate)** — the gold-standard Go migration tool. pgmigrate mirrors its dirty-flag protocol, advisory lock mechanism (CRC32 salt `1486364155`), and force-recovery semantics.
- **[porsager/postgres](https://github.com/porsager/postgres)** — PostgreSQL client library.
