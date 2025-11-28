import { DatabaseSync } from "node:sqlite"

import { decodePath, encodePath, increment } from "./encoding.ts"
import { type Inner, instanciate, key, PREFIX, PREPARED, table } from "./proxy.ts"

/** Scalar values that can be stored in a {@link Table} */
export type Scalar = null | boolean | number | string | bigint | Date | RegExp
/** Complex values that can be stored in a {@link Table} */
export type Complex = { [key: number | string]: Scalar | Complex } | (Scalar | Complex)[]

/** A persistent JavaScript object backed by a SQLite table */
export type Table = Record<number | string, Scalar | Complex>

/** A SQLite database */
export class Database implements Disposable {
	readonly #inner: DatabaseSync

	/** Opens an existing database at the given path, or creates it if it does not exist */
	constructor(path: string) {
		this.#inner = new DatabaseSync(path)
		this.#inner.exec(`
		  PRAGMA journal_mode = WAL;
			PRAGMA synchronous = normal;
		`)
	}

	/** Returns a persistent JavaScript object backed by the given table, creating it if it didn't exist */
	table(name: string): Table {
		return table(this.#inner, name)
	}

	/**
	 * Returns an iterator over the key-value pairs of the given object
	 *
	 * For regular objects this is the same as iterating over the result of {@link Object.entries},
	 * but for objects contained in a {@link Table} this is much more efficient as it is lazy.
	 * This method should be preffered especially for objects that may contain a large number of keys.
	 */
	static entries(
		object: Complex,
	): IteratorObject<[key: number | string, value: Scalar | Complex], void, undefined> {
		const inner = object as unknown as Inner
		const prefix = inner[PREFIX]
		if (!prefix) {
			return Object.entries(object)
				[Symbol.iterator]()
				.map(([prop, value]) => [key(prop), value])
		}

		const encoded = encodePath(prefix)
		const rows = inner[PREPARED].selectMany.iterate({
			":lower": encoded,
			":upper": increment(encoded),
		})

		return rows
			.map((row) => {
				const { path, value } = row as {
					path: Uint8Array<ArrayBuffer>
					value: Uint8Array<ArrayBuffer>
				}
				return [decodePath(new DataView(path.buffer)), value] as const
			})
			.filter(([path]) => path.length === prefix.length + 1)
			.map(([path, value]) => [
				path.at(-1)!,
				instanciate(new DataView(value.buffer), inner, path),
			])
	}

	/**
	 * Returns an iterator over the keys of the given object
	 * @see {@link Database.entries}
	 */
	static keys(object: Complex): IteratorObject<number | string, void, undefined> {
		return Database.entries(object).map(([key]) => key)
	}
	/**
	 * Returns an iterator over the values of the given object
	 * @see {@link Database.entries}
	 */
	staticvalues(object: Complex): IteratorObject<Scalar | Complex, void, undefined> {
		return Database.entries(object).map(([, value]) => value)
	}

	[Symbol.dispose](): void {
		this.#inner[Symbol.dispose]()
	}
}
export default Database
