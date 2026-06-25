/// <reference types="./postgres.d.ts" />
import type { Sql } from "postgres";
import type { Types } from "./Types.js";
import { ADVISORY_LOCK_SALT } from "./CLI.js";

export namespace Track {
  /**
   * CRC32 IEEE (standard implementation, no platform deps).
   * Uses the same polynomial as golang-migrate.
   */
  export function crc32(str: string): number {
    let crc = 0xffffffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i);
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Compute a PostgreSQL advisory lock ID from a database name,
   * mirroring golang-migrate's GenerateAdvisoryLockId.
   */
  export function advisoryLockId(dbName: string): number {
    const crcVal = crc32(dbName);
    return Math.imul(crcVal, ADVISORY_LOCK_SALT) >>> 0;
  }

  /**
   * Acquire a PostgreSQL advisory lock. Blocks until acquired.
   */
  export async function lock(
    sql: Sql,
    dbName: string,
  ): Promise<Types.Result<void>> {
    try {
      const lockId = advisoryLockId(dbName);
      await sql`SELECT pg_advisory_lock(${lockId})`;
      return [undefined, undefined];
    } catch (err) {
      return [
        null,
        new Error(
          `Failed to acquire advisory lock: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }

  /**
   * Release a PostgreSQL advisory lock.
   */
  export async function unlock(
    sql: Sql,
    dbName: string,
  ): Promise<Types.Result<void>> {
    try {
      const lockId = advisoryLockId(dbName);
      await sql`SELECT pg_advisory_unlock(${lockId})`;
      return [undefined, undefined];
    } catch (err) {
      return [
        null,
        new Error(
          `Failed to release advisory lock: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }

  /**
   * Ensure the tracking table exists as an append-only log.
   * Checks information_schema first to support read-only users.
   */
  export async function ensureTable(
    sql: Sql,
    tableName: string,
  ): Promise<Types.Result<void>> {
    try {
      const rows = await sql`
				SELECT COUNT(1) AS cnt
				FROM information_schema.tables
				WHERE table_schema = 'public' AND table_name = ${tableName}
				LIMIT 1
			`;
      if (rows.length > 0 && Number(rows[0]!["cnt"]) > 0) {
        return [undefined, undefined];
      }

      await sql`
				CREATE TABLE IF NOT EXISTS ${sql(tableName)} (
					version    text        NOT NULL,
					dirty      boolean     NOT NULL DEFAULT false,
					applied_at timestamptz NOT NULL DEFAULT now()
				)
			`;
      return [undefined, undefined];
    } catch (err) {
      return [
        null,
        new Error(
          `Failed to ensure tracking table '${tableName}': ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }

  /**
   * Read the current state from the tracking table.
   * The latest row (by applied_at) is the authoritative state.
   * Returns { version: null, dirty: false } if no rows exist.
   */
  export async function getState(
    sql: Sql,
    tableName: string,
  ): Promise<Types.Result<Types.TrackState>> {
    try {
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
          `Failed to read tracking state: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }

  /**
   * Append a version event to the tracking log.
   *
   * No TRUNCATE or UPDATE — only INSERT. The current state is always
   * the latest row by applied_at. A crash between the dirty=true insert
   * and the dirty=false insert leaves forensic evidence: the last row
   * has dirty=true, and all future migration runs are blocked.
   *
   * @param dirty true = attempting, false = completed
   */
  export async function setVersion(
    sql: Sql,
    tableName: string,
    version: Types.Version,
    dirty: boolean,
  ): Promise<Types.Result<void>> {
    try {
      await sql`
				INSERT INTO ${sql(tableName)} (version, dirty, applied_at)
				VALUES (${version}, ${dirty}, now())
			`;
      return [undefined, undefined];
    } catch (err) {
      return [
        null,
        new Error(
          `Failed to record version '${version}' in tracking log: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ];
    }
  }
}
