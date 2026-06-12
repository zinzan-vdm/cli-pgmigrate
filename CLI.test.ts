import { describe, it, expect } from 'bun:test';
import { parseArgs, isForward, isBackward, sameVersion } from './CLI.js';

describe('parseArgs', () => {
	it('should parse basic required args', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--to', '20260612T0015-01', 'postgres://localhost/mydb']);
		expect(err).toBeUndefined();
		expect(opts!.to).toBe('20260612T0015-01');
		expect(opts!.databaseUri).toBe('postgres://localhost/mydb');
		expect(opts!.source).toBe('.');
		expect(opts!.force).toBe(false);
		expect(opts!.config).toBe('./config.yml');
	});

	it('should parse --force flag', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--to', '20260612T0015-01', '--force', 'postgres://localhost/mydb']);
		expect(err).toBeUndefined();
		expect(opts!.force).toBe(true);
	});

	it('should parse --source', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--source', './migrations', '--to', '20260612T0015-01', 'postgres://localhost/mydb']);
		expect(err).toBeUndefined();
		expect(opts!.source).toBe('./migrations');
		expect(opts!.config).toBe('./migrations/config.yml');
	});

	it('should parse --config', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--config', './cfg.yml', '--to', '20260612T0015-01', 'postgres://localhost/mydb']);
		expect(err).toBeUndefined();
		expect(opts!.config).toBe('./cfg.yml');
	});

	it('should parse --from', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--from', '20260612T0015-00', '--to', '20260612T0015-01', 'postgres://localhost/mydb']);
		expect(err).toBeUndefined();
		expect(opts!.from).toBe('20260612T0015-00');
	});

	it('should error when --to is missing', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', 'postgres://localhost/mydb']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('--to is required');
	});

	it('should error when URI is missing', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--to', '20260612T0015-01']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('Database URI is required');
	});

	it('should error on invalid version format', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--to', '1.0.0', 'postgres://localhost/mydb']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('Invalid version format');
	});

	it('should error on unknown option', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--bogus', 'postgres://localhost/mydb']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('Unknown option');
	});

	it('should error on extra positional arguments', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--to', '20260612T0015-01', 'uri1', 'uri2']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('Database URI already provided');
	});

	it('should error when --to has no value', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--to']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('--to requires a version argument');
	});

	it('should error when --from has invalid format', () => {
		const [opts, err] = parseArgs(['node', 'index.ts', '--from', 'bad', '--to', '20260612T0015-01', 'postgres://localhost/mydb']);
		expect(opts).toBeNull();
		expect(err!.message).toContain('Invalid version format');
	});
});

describe('isForward', () => {
	it('should return true when from < to', () => {
		expect(isForward('20260612T0015-00', '20260612T0015-01')).toBe(true);
	});

	it('should return false when from > to', () => {
		expect(isForward('20260612T0015-01', '20260612T0015-00')).toBe(false);
	});

	it('should return false when equal', () => {
		expect(isForward('20260612T0015-00', '20260612T0015-00')).toBe(false);
	});
});

describe('isBackward', () => {
	it('should return true when from > to', () => {
		expect(isBackward('20260612T0015-01', '20260612T0015-00')).toBe(true);
	});

	it('should return false when from < to', () => {
		expect(isBackward('20260612T0015-00', '20260612T0015-01')).toBe(false);
	});
});

describe('sameVersion', () => {
	it('should return true for equal versions', () => {
		expect(sameVersion('20260612T0015-00', '20260612T0015-00')).toBe(true);
	});

	it('should return false for different versions', () => {
		expect(sameVersion('20260612T0015-00', '20260612T0015-01')).toBe(false);
	});
});