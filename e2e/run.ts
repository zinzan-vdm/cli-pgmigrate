#!/usr/bin/env bun
/**
 * pgmigrate end-to-end test suite.
 *
 * Starts PostgreSQL in Docker with trust auth, runs migrations with the
 * pgmigrate binary, and asserts results using the postgres.js driver —
 * no psql required.
 *
 * Requires: docker, bun.
 */

import { $ } from "bun";
import postgres from "postgres";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- Paths ----------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = resolve(__dirname, "migrations");
const CONTAINER = "pgmigrate-e2e";
const PORT = "5432";
const PG_USER = "pg";
const PG_DB = "pgmigrate_e2e";
const PG_URI = `postgres://${PG_USER}@localhost:${PORT}/${PG_DB}`;
const PG_FRESH_DB = "pgmigrate_fresh";

// --- Test harness ---------------------------------------------------------

let passCount = 0;
let failCount = 0;

function pass(label: string) {
  console.log(`  PASS  ${label}`);
  passCount++;
}

function fail(label: string, detail?: string) {
  console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  failCount++;
}

function assertEq(label: string, expected: unknown, actual: unknown) {
  if (expected === actual) {
    pass(label);
  } else {
    fail(label, `expected '${expected}', got '${actual}'`);
  }
}

// --- Helpers --------------------------------------------------------------

async function runPgmigrate(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawnSync([resolve(ROOT, "pgmigrate"), ...args], {
    cwd: MIGRATIONS_DIR,
    env: { ...process.env },
  });
  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
  };
}

async function waitForPostgres(maxSec = 30): Promise<void> {
  for (let i = 0; i < maxSec; i++) {
    const sql = postgres(PG_URI, { connect_timeout: 2 });
    try {
      await sql`SELECT 1`;
      await sql.end();
      return;
    } catch {
      await sql.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("PostgreSQL did not become ready within timeout");
}

function connect(db = PG_DB) {
  return postgres(`postgres://${PG_USER}@localhost:${PORT}/${db}`);
}

async function cleanup(): Promise<void> {
  await $`docker rm -f ${CONTAINER}`.quiet().nothrow();
}

// --- Setup ----------------------------------------------------------------

console.log("=== pgmigrate e2e ===\n");

// Clean up any leftover container
await $`docker rm -f ${CONTAINER}`.quiet().nothrow();

// Start PostgreSQL with trust auth (no password needed)
console.log("--- Starting PostgreSQL...");
const startResult = await $`docker run -d \
  --name ${CONTAINER} \
  -e POSTGRES_USER=${PG_USER} \
  -e POSTGRES_DB=${PG_DB} \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p ${PORT}:5432 \
  postgres:16-alpine`.quiet();
console.log(`  Container: ${startResult.stdout.toString().trim()}`);

console.log("--- Waiting for PostgreSQL...");
await waitForPostgres();
pass("PostgreSQL is ready");

// ==========================================================================
// TEST 1: Forward migration (00 → 02)
// ==========================================================================
console.log("\n=== Test 1: Forward 00→02 ===");

const fwd = await runPgmigrate(["--to", "20260612T0000-02", PG_URI]);
assertEq("forward migration completed", 0, fwd.exitCode);

const sql1 = connect();
try {
  const [{ exists: tableExists }] = await sql1`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'users'
    ) AS exists
  `;
  assertEq("table users exists", true, tableExists);

  const [{ exists: colExists }] = await sql1`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'name'
    ) AS exists
  `;
  assertEq("column name exists", true, colExists);

  const [{ count }] = await sql1`SELECT COUNT(*)::int AS count FROM users`;
  assertEq("2 users", 2, count);

  const [{ email: aliceEmail }] = await sql1`SELECT email FROM users WHERE name = 'Alice'`;
  assertEq("alice@test.com", "alice@test.com", aliceEmail);

  const [{ email: bobEmail }] = await sql1`SELECT email FROM users WHERE name = 'Bob'`;
  assertEq("bob@test.com", "bob@test.com", bobEmail);

  const [{ exists: roleExists }] = await sql1`
    SELECT EXISTS (
      SELECT FROM pg_roles WHERE rolname = 'e2e_reader'
    ) AS exists
  `;
  assertEq("role e2e_reader exists", true, roleExists);

  const [{ count: logCount }] = await sql1`SELECT COUNT(*)::int AS count FROM _migrations`;
  assertEq("tracking log: 6 rows", 6, logCount);

  const [{ dirty }] = await sql1`
    SELECT dirty FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("latest row clean", false, dirty);

  const [{ version }] = await sql1`
    SELECT version FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("latest version 02", "20260612T0000-02", version);
} finally {
  await sql1.end();
}

// ==========================================================================
// TEST 2: No-op when already at target
// ==========================================================================
console.log("\n=== Test 2: No-op at target ===");

const noop = await runPgmigrate(["--to", "20260612T0000-02", PG_URI]);
assertEq("nothing to do message", true, noop.stdout.includes("Nothing to do"));
assertEq("exit code 0", 0, noop.exitCode);

const sql2 = connect();
try {
  const [{ count: logCount }] = await sql2`SELECT COUNT(*)::int AS count FROM _migrations`;
  assertEq("tracking log unchanged", 6, logCount);
} finally {
  await sql2.end();
}

// ==========================================================================
// TEST 3: Rollback (02 → 00)
// ==========================================================================
console.log("\n=== Test 3: Rollback 02→00 ===");

const rb = await runPgmigrate(["--from", "20260612T0000-02", "--to", "20260612T0000-00", PG_URI]);
assertEq("rollback completed", 0, rb.exitCode);

const sql3 = connect();
try {
  const [{ exists: roleExists }] = await sql3`
    SELECT EXISTS (
      SELECT FROM pg_roles WHERE rolname = 'e2e_reader'
    ) AS exists
  `;
  assertEq("role e2e_reader removed", false, roleExists);

  const [{ exists: colExists }] = await sql3`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'name'
    ) AS exists
  `;
  assertEq("column name removed", false, colExists);

  const [{ exists: tableExists }] = await sql3`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'users'
    ) AS exists
  `;
  assertEq("table users still exists", true, tableExists);

  const [{ version }] = await sql3`
    SELECT version FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("latest version 00", "20260612T0000-00", version);

  const [{ dirty }] = await sql3`
    SELECT dirty FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("latest row clean", false, dirty);

  const [{ count: logCount }] = await sql3`SELECT COUNT(*)::int AS count FROM _migrations`;
  assertEq("tracking log: 10 rows", 10, logCount);
} finally {
  await sql3.end();
}

// ==========================================================================
// TEST 4: Dirty-flag detection
// ==========================================================================
console.log("\n=== Test 4: Dirty-flag detection ===");

const sql4 = connect();
try {
  await sql4`
    INSERT INTO _migrations (version, dirty) VALUES ('20260612T0000-01', true)
  `;
  pass("dirty row injected");
} finally {
  await sql4.end();
}

const dirty = await runPgmigrate(["--to", "20260612T0000-02", PG_URI]);
assertEq("migration blocked by dirty flag", true, dirty.stdout.toLowerCase().includes("dirty"));
assertEq("exit code 1", 1, dirty.exitCode);

const sql4b = connect();
try {
  const [{ dirty: dirtyFlag }] = await sql4b`
    SELECT dirty FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("dirty flag persists", true, dirtyFlag);
} finally {
  await sql4b.end();
}

// Inject another dirty row for 01 so force recovery can target it
const sql4c = connect();
try {
  await sql4c`
    INSERT INTO _migrations (version, dirty) VALUES ('20260612T0000-01', true)
  `;
} finally {
  await sql4c.end();
}

// ==========================================================================
// TEST 5: Force recovery
// ==========================================================================
console.log("\n=== Test 5: Force recovery ===");

const force = await runPgmigrate(["--to", "20260612T0000-01", "--force", PG_URI]);
assertEq("force recovery completed", 0, force.exitCode);

const sql5 = connect();
try {
  const [{ dirty: dirtyFlag }] = await sql5`
    SELECT dirty FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("dirty flag cleared", false, dirtyFlag);

  const [{ version }] = await sql5`
    SELECT version FROM _migrations ORDER BY applied_at DESC LIMIT 1
  `;
  assertEq("version set to 01", "20260612T0000-01", version);
} finally {
  await sql5.end();
}

const fwdAgain = await runPgmigrate(["--to", "20260612T0000-02", PG_URI]);
assertEq("forward works after force recovery", 0, fwdAgain.exitCode);

// ==========================================================================
// TEST 6: Fresh database
// ==========================================================================
console.log("\n=== Test 6: Fresh database ===\n");

const sql6 = connect();
try {
  // Drop any leftover objects from prior tests that could conflict
  try { await sql6`DROP OWNED BY e2e_reader CASCADE`; } catch {}
  try { await sql6`DROP ROLE IF EXISTS e2e_reader`; } catch {}

  await sql6`CREATE DATABASE ${sql6(PG_FRESH_DB)}`;
  pass("fresh database created");

  const freshUri = `postgres://${PG_USER}@localhost:${PORT}/${PG_FRESH_DB}`;
  const fresh = await runPgmigrate(["--to", "20260612T0000-02", freshUri]);
  assertEq("fresh database migrated", 0, fresh.exitCode);

  const sqlFresh = connect(PG_FRESH_DB);
  try {
    const [{ exists: tableExists }] = await sqlFresh`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'users'
      ) AS exists
    `;
    assertEq("fresh: table exists", true, tableExists);

    const [{ count }] = await sqlFresh`SELECT COUNT(*)::int AS count FROM users`;
    assertEq("fresh: 2 users", 2, count);

    const [{ count: logCount }] = await sqlFresh`SELECT COUNT(*)::int AS count FROM _migrations`;
    assertEq("fresh: tracking log 6 rows", 6, logCount);
  } finally {
    await sqlFresh.end();
  }
} finally {
  await sql6.end();
}

// ==========================================================================
// Summary
// ==========================================================================
console.log("\n=== Results ===");
console.log(`  Pass: ${passCount}`);
console.log(`  Fail: ${failCount}`);
if (failCount > 0) {
  console.log("  OVERALL: FAIL");
  await cleanup();
  process.exit(1);
}
console.log("  OVERALL: PASS");
await cleanup();