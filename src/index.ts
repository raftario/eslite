import { DatabaseSync } from "node:sqlite"

import { table } from "./table.ts"

export type Scalar = null | boolean | number | string | bigint | Date | RegExp
export type Table = { [key: number | string]: Scalar | Table } | (Scalar | Table)[]

export class Database implements Disposable {
	readonly #inner: DatabaseSync

	constructor(path: string) {
		this.#inner = new DatabaseSync(path)
		this.#inner.exec(`
		  PRAGMA journal_mode = WAL;
			PRAGMA synchronous = normal;
		`)
	}

	table(name: string): Table {
		return table(this.#inner, name)
	}

	[Symbol.dispose](): void {
		this.#inner[Symbol.dispose]()
	}
}
export default Database
