export namespace Types {
	/** Version string: '20260612T0015-00' */
	export type Version = string;

	/** File type within a version directory */
	export type FileType = 'up' | 'down';

	/** Parsed CLI options */
	export type CLIOptions = {
		to: Version;
		from?: Version;
		source: string;
		config: string;
		force: boolean;
		databaseUri: string;
	};

	/** Tracking table config */
	export type TrackingConfig = {
		tableName: string;
	};

	/** Full config file shape */
	export type Config = {
		tracking: TrackingConfig;
	};

	/** Current state of the tracking table */
	export type TrackState = {
		version: Version | null;
		dirty: boolean;
	};

	/** A version directory found on disk */
	export type VersionDir = {
		version: Version;
		upPath: string;
		downPath: string;
	};

	/** Result tuple: [value, undefined] on success, [null, Error] on failure */
	export type Result<T> = [T, undefined] | [null, Error];
}