import { describe, it, expect } from 'bun:test';
import { Track } from './Track.js';

/**
 * Create a mock postgres `sql` function that handles both calling patterns:
 *   sql(tableName)     → returns the name (acts as SqlFragment for interpolation)
 *   sql`SELECT ...`    → returns Promise<rows[]>
 *   sql.unsafe(...)    → returns Promise<rows[]>
 */
function mockSql(options?: { rows?: unknown[] }): any {
	const rows = options?.rows ?? [];
	return new Proxy(
		(first: unknown, ..._rest: unknown[]) => {
			// Tagged template call: first is a TemplateStringsArray (array-like)
			if (Array.isArray(first)) {
				return Promise.resolve(rows);
			}
			// Identifier call: sql('_migrations') → return the string itself
			return first;
		},
		{
			get(target, prop) {
				if (prop === 'unsafe') {
					return async (_query: string) => Promise.resolve(rows);
				}
				return (target as any)[prop];
			},
		},
	) as any;
}

describe('Track.crc32', () => {
	it('should produce deterministic results', () => {
		const a = Track.crc32('hello');
		const b = Track.crc32('hello');
		expect(a).toBe(b);
	});

	it('should produce different results for different inputs', () => {
		const a = Track.crc32('testdb');
		const b = Track.crc32('otherdb');
		expect(a).not.toBe(b);
	});

	it('should produce a uint32 value', () => {
		const val = Track.crc32('test');
		expect(val).toBeGreaterThanOrEqual(0);
		expect(val).toBeLessThanOrEqual(0xffffffff);
	});

	it('should handle empty string', () => {
		const val = Track.crc32('');
		expect(val).toBeGreaterThanOrEqual(0);
	});
});

describe('Track.advisoryLockId', () => {
	it('should produce deterministic results', () => {
		const a = Track.advisoryLockId('testdb');
		const b = Track.advisoryLockId('testdb');
		expect(a).toBe(b);
	});

	it('should produce different IDs for different databases', () => {
		const a = Track.advisoryLockId('db_a');
		const b = Track.advisoryLockId('db_b');
		expect(a).not.toBe(b);
	});

	it('should produce a valid uint32', () => {
		const val = Track.advisoryLockId('testdb');
		expect(val).toBeGreaterThanOrEqual(0);
		expect(val).toBeLessThanOrEqual(0xffffffff);
	});

	it('should match golang-migrate formula', () => {
		const crcVal = Track.crc32('test');
		const product = Math.imul(crcVal, 1486364155) >>> 0;
		expect(Track.advisoryLockId('test')).toBe(product);
	});
});

describe('Track.lock', () => {
	it('should acquire advisory lock', async () => {
		const sql = mockSql();
		const [_, err] = await Track.lock(sql, 'testdb');
		expect(err).toBeUndefined();
	});

	it('should return error on failure', async () => {
		const sql = new Proxy(mockSql(), {
			apply() { throw new Error('connection terminated'); },
		}) as any;
		const [_, err] = await Track.lock(sql, 'testdb');
		expect(err).not.toBeUndefined();
		expect(err!.message).toContain('Failed to acquire advisory lock');
	});
});

describe('Track.unlock', () => {
	it('should release advisory lock', async () => {
		const sql = mockSql();
		const [_, err] = await Track.unlock(sql, 'testdb');
		expect(err).toBeUndefined();
	});

	it('should return error on failure', async () => {
		const sql = new Proxy(mockSql(), {
			apply() { throw new Error('lock not held'); },
		}) as any;
		const [_, err] = await Track.unlock(sql, 'testdb');
		expect(err).not.toBeUndefined();
		expect(err!.message).toContain('Failed to release advisory lock');
	});
});

describe('Track.setVersion', () => {
	it('should INSERT a row', async () => {
		const sql = mockSql();
		const [_, err] = await Track.setVersion(sql, '_migrations', '20260612T0015-01', true);
		expect(err).toBeUndefined();
	});

	it('should return error on failure', async () => {
		const sql = new Proxy(mockSql(), {
			apply() { throw new Error('relation "_migrations" does not exist'); },
		}) as any;
		const [_, err] = await Track.setVersion(sql, '_migrations', '20260612T0015-01', true);
		expect(err).not.toBeUndefined();
		expect(err!.message).toContain('Failed to record version');
	});
});

describe('Track.ensureTable', () => {
	it('should create table without PRIMARY KEY', async () => {
		// First call: info_schema check (empty) → second call: CREATE TABLE
		let callCount = 0;
		let capturedSql = '';

		const sql = new Proxy(
			(first: unknown, ..._rest: unknown[]) => {
				callCount++;
				if (callCount === 1) {
					// information_schema check — return empty (table doesn't exist)
					return Promise.resolve([]);
				}
				// CREATE TABLE — capture the generated SQL
				if (Array.isArray(first)) {
					capturedSql = String(first);
				}
				return Promise.resolve([]);
			},
			{ get: (target, prop) => (target as any)[prop] },
		) as any;

		const [_, err] = await Track.ensureTable(sql, '_migrations');
		expect(err).toBeUndefined();
		expect(capturedSql).not.toContain('PRIMARY KEY');
		expect(capturedSql).toContain('version');
		expect(capturedSql).toContain('dirty');
		expect(capturedSql).toContain('applied_at');
	});

	it('should skip CREATE TABLE if table already exists', async () => {
		let callCount = 0;

		const sql = new Proxy(
			() => {
				callCount++;
				// Return count=1 for the information_schema check
				return Promise.resolve([{ cnt: 1 }]);
			},
			{ get: (target, prop) => (target as any)[prop] },
		) as any;

		const [_, err] = await Track.ensureTable(sql, '_migrations');
		expect(err).toBeUndefined();
		expect(callCount).toBe(1);
	});
});

describe('Track.getState', () => {
	it('should return null state for empty table', async () => {
		const sql = mockSql();
		const [state, err] = await Track.getState(sql, '_migrations');
		expect(err).toBeUndefined();
		expect(state!.version).toBeNull();
		expect(state!.dirty).toBe(false);
	});

	it('should return latest row by applied_at', async () => {
		const sql = mockSql({ rows: [{ version: '20260612T0015-01', dirty: false }] });
		const [state, err] = await Track.getState(sql, '_migrations');
		expect(err).toBeUndefined();
		expect(state!.version).toBe('20260612T0015-01');
		expect(state!.dirty).toBe(false);
	});

	it('should return error on failure', async () => {
		const sql = new Proxy(mockSql(), {
			apply() { throw new Error('relation "_migrations" does not exist'); },
		}) as any;
		const [_, err] = await Track.getState(sql, '_migrations');
		expect(err).not.toBeUndefined();
		expect(err!.message).toContain('Failed to read tracking state');
	});
});