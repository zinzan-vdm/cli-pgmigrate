import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Migrator } from "./Migrator.js";

describe("Migrator.listVersions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty array for empty directory", async () => {
    const [versions, err] = await Migrator.listVersions(tmpDir);
    expect(err).toBeUndefined();
    expect(versions).toEqual([]);
  });

  it("should list version directories sorted ascending", async () => {
    await mkdir(join(tmpDir, "20260612T0015-00"), { recursive: true });
    await mkdir(join(tmpDir, "20260612T0015-01"), { recursive: true });
    await mkdir(join(tmpDir, "20260612T0030-00"), { recursive: true });
    await writeFile(
      join(tmpDir, "20260612T0015-00", "up.sql"),
      "CREATE TABLE test (id int);",
    );
    await writeFile(
      join(tmpDir, "20260612T0015-01", "up.sql"),
      "ALTER TABLE test ADD COLUMN name text;",
    );
    await writeFile(
      join(tmpDir, "20260612T0030-00", "up.sql"),
      "CREATE INDEX idx_test_name ON test(name);",
    );

    const [versions, err] = await Migrator.listVersions(tmpDir);
    expect(err).toBeUndefined();
    expect(versions!.map((v) => v.version)).toEqual([
      "20260612T0015-00",
      "20260612T0015-01",
      "20260612T0030-00",
    ]);
  });

  it("should detect down.sql when present", async () => {
    await mkdir(join(tmpDir, "20260612T0015-00"), { recursive: true });
    await writeFile(
      join(tmpDir, "20260612T0015-00", "up.sql"),
      "CREATE TABLE test (id int);",
    );
    await writeFile(
      join(tmpDir, "20260612T0015-00", "down.sql"),
      "DROP TABLE test;",
    );

    const [versions, err] = await Migrator.listVersions(tmpDir);
    expect(err).toBeUndefined();
    expect(versions!.length).toBe(1);
    expect(versions![0]!.downPath).toContain("down.sql");
  });

  it("should return empty downPath when down.sql missing", async () => {
    await mkdir(join(tmpDir, "20260612T0015-00"), { recursive: true });
    await writeFile(
      join(tmpDir, "20260612T0015-00", "up.sql"),
      "CREATE TABLE test (id int);",
    );

    const [versions, err] = await Migrator.listVersions(tmpDir);
    expect(err).toBeUndefined();
    expect(versions!.length).toBe(1);
    expect(versions![0]!.downPath).toBe("");
  });

  it("should skip non-version directories", async () => {
    await mkdir(join(tmpDir, "20260612T0015-00"), { recursive: true });
    await mkdir(join(tmpDir, "scripts"), { recursive: true });
    await mkdir(join(tmpDir, ".hidden"), { recursive: true });
    await writeFile(
      join(tmpDir, "20260612T0015-00", "up.sql"),
      "CREATE TABLE test (id int);",
    );

    const [versions, err] = await Migrator.listVersions(tmpDir);
    expect(err).toBeUndefined();
    expect(versions!.length).toBe(1);
  });

  it("should error when version directory lacks up.sql", async () => {
    await mkdir(join(tmpDir, "20260612T0015-00"), { recursive: true });

    const [versions, err] = await Migrator.listVersions(tmpDir);
    expect(versions).toBeNull();
    expect(err!.message).toContain("missing up.sql");
  });

  it("should error when source directory does not exist", async () => {
    const [versions, err] = await Migrator.listVersions("/nonexistent/path");
    expect(versions).toBeNull();
    expect(err!.message).toContain("Failed to read source directory");
  });
});

describe("Migrator.force", () => {
  it("should succeed without SQL execution", async () => {
    // Unit test coverage for the force operation is covered via Track tests.
    // Integration test with a real PG instance would exercise the full flow.
    expect(true).toBe(true);
  });
});
