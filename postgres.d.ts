/**
 * Minimal type declaration for the `postgres` npm package (porsager/postgres v3).
 * Only defines the subset we use.
 *
 * Full types ship with the package at node_modules/postgres/types/index.d.ts.
 */
declare module 'postgres' {
	// The sql tagged-template function
	interface Sql {
		(strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
		(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;

		/** Safely interpolate identifiers (table names, columns) */
		(identifier: string): SqlFragment;

		/** Begin a transaction */
		begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;

		/** Unsafe query execution */
		unsafe(query: string, values?: unknown[]): Promise<Record<string, unknown>[]>;

		/** End the connection pool */
		end(): Promise<void>;
	}

	interface SqlFragment {
		(strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
	}

	function postgres(connectionString: string, options?: Record<string, unknown>): Sql;

	export default postgres;
	export type { Sql };
}