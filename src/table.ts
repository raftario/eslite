import type { DatabaseSync, StatementSync } from "node:sqlite"

import { decodePath, decodeValue, encodePath, encodeValue, increment } from "./encoding.ts"
import type { Table } from "./index.ts"
import { CYCLES, DATABASE, type Path, PREFIX, PREPARED, PROTOTYPE } from "./internal.ts"

interface Inner {
	[PROTOTYPE]: null | typeof Array.prototype
	[DATABASE]: DatabaseSync
	[PREFIX]: Path
	[PREPARED]: {
		selectOne: StatementSync
		selectMany: StatementSync
		insert: StatementSync
		delete: StatementSync
		length: StatementSync
	}
	[CYCLES]?: WeakSet<object>
}

const OBJECT_TAGS = {
	RECORD: 0xff - 0,
	ARRAY: 0xff - 1,
}

export function table(database: DatabaseSync, name: string): Table {
	const table = JSON.stringify(name)
	database.exec(`
	  CREATE TABLE IF NOT EXISTS ${table} (
			path BLOB PRIMARY KEY NOT NULL,
			value BLOB NOT NULL
		) WITHOUT ROWID
	`)

	return proxy({
		[PROTOTYPE]: null,
		[DATABASE]: database,
		[PREFIX]: [],
		[PREPARED]: {
			selectOne: database.prepare(`SELECT value FROM ${table} WHERE path == :path`),
			selectMany: database.prepare(
				`SELECT path FROM ${table} WHERE path >= :lower AND path < :upper`,
			),
			insert: database.prepare(`INSERT INTO ${table} (path, value) VALUES (:path, :value)`),
			delete: database.prepare(`DELETE FROM ${table} WHERE path >= :lower AND path < :upper`),
			length: database.prepare(`
			  SELECT path FROM ${table}
				WHERE LENGTH(path) == LENGTH(:lower) AND path >= :lower AND path < :upper
				ORDER BY path DESC LIMIT 1
			`),
		},
	})
}

function proxy(inner: Inner): Table {
	const proxied = new Proxy(inner, {
		getPrototypeOf(target) {
			return target[PROTOTYPE]
		},
		setPrototypeOf() {
			return false
		},
		isExtensible() {
			return true
		},
		preventExtensions() {
			return false
		},

		getOwnPropertyDescriptor(target, prop) {
			// Special cased array length
			if (target[PROTOTYPE] === Array.prototype && prop === "length") {
				const row = target[PREPARED].length.get({
					":lower": encodePath([...target[PREFIX], 0]),
					":upper": encodePath([...target[PREFIX], 0xffff_ffff]),
				})
				if (row === undefined) {
					return { enumerable: false, configurable: true, writable: true, value: 0 }
				}

				const { path } = row as { path: Uint8Array<ArrayBuffer> }
				const decoded = decodePath(new DataView(path.buffer))
				return {
					enumerable: false,
					configurable: false,
					writable: true,
					value: (decoded.at(-1) as number) + 1,
				}
			}

			// Proxy symbol accessors directly to the inner object
			if (typeof prop === "symbol") {
				const value = Reflect.get(target, prop, target)
				if (value === undefined) {
					return undefined
				}

				return { enumerable: false, writable: false, configurable: true, value }
			}

			// Create and encode the full path
			const prefix = [...target[PREFIX], key(prop)]
			const encoded = encodePath(prefix)

			const row = target[PREPARED].selectOne.get({
				":path": encoded,
			})
			if (row === undefined) {
				return undefined
			}

			const { value } = row as { value: Uint8Array<ArrayBuffer> }
			switch (value[0]) {
				case OBJECT_TAGS.RECORD: {
					return {
						enumerable: true,
						configurable: true,
						writable: true,
						value: proxy({ ...target, [PROTOTYPE]: null, [PREFIX]: prefix }),
					}
				}

				case OBJECT_TAGS.ARRAY: {
					return {
						enumerable: true,
						configurable: true,
						writable: true,
						// We need to define a non-configurable length property for proxy correctness
						value: proxy(
							Object.defineProperty(
								{ ...target, [PROTOTYPE]: Array.prototype, [PREFIX]: prefix },
								"length",
								{
									enumerable: false,
									configurable: false,
									writable: true,
									value: 0,
								},
							),
						),
					}
				}

				default: {
					return {
						enumerable: true,
						configurable: true,
						writable: true,
						value: decodeValue(new DataView(value.buffer)),
					}
				}
			}
		},

		get(target, prop, receiver) {
			const descriptor = this.getOwnPropertyDescriptor!(target, prop)
			if (descriptor !== undefined) {
				return descriptor.value
			}

			const proto = target[PROTOTYPE]
			if (proto === null) {
				return undefined
			}

			return Reflect.get(proto, prop, receiver)
		},

		has(target, prop) {
			const descriptor = this.getOwnPropertyDescriptor!(target, prop)
			if (descriptor !== undefined) {
				return true
			}

			const proto = target[PROTOTYPE]
			if (proto === null) {
				return false
			}

			return Reflect.has(proto, prop)
		},

		defineProperty(target, prop, desc) {
			const value = desc.value
			if (typeof prop === "symbol") {
				return false
			} else if (value === undefined) {
				this.deleteProperty!(target, prop)
				return true
			}

			const prefix = [...target[PREFIX], key(prop)]
			const encoded = encodePath(prefix)

			const array = Array.isArray(value)
			const record =
				typeof value === "object"
				&& value !== null
				&& [null, Object.prototype].includes(Object.getPrototypeOf(value))

			const database = target[DATABASE]
			const cycles = target[CYCLES]

			try {
				if (!cycles) {
					database.exec("BEGIN")
					target[PREPARED].delete.run({
						":lower": encoded,
						":upper": increment(encoded),
					})
				}

				if (target[PROTOTYPE] === Array.prototype && prop === "length") {
					const length = Number(value)
					if (!Number.isSafeInteger(length) || length < 0 || length >= 0xffff_ffff) {
						throw new RangeError("Invalid array length")
					}

					if (
						desc.enumerable === true
						|| desc.configurable === true
						|| desc.writable === false
					) {
						throw new TypeError("Invalid array length property descriptor")
					}

					target[PREPARED].delete.run({
						":lower": encodePath([...target[PREFIX], length]),
						":upper": encodePath([...target[PREFIX], 0xffff_ffff]),
					})
				} else if (!array && !record) {
					if (
						desc.enumerable === false
						|| desc.configurable === false
						|| desc.writable === false
					) {
						throw new TypeError("Invalid property descriptor")
					}

					target[PREPARED].insert.run({
						":path": encoded,
						":value": encodeValue(value),
					})
				} else {
					if (!cycles) {
						target[CYCLES] = new WeakSet([value])
					} else {
						if (cycles.has(value)) {
							throw new ReferenceError("Cyclic object")
						}
						cycles.add(value)
					}

					if (
						desc.enumerable === false
						|| desc.configurable === false
						|| desc.writable === false
					) {
						throw new TypeError("Invalid property descriptor")
					}

					const view = new DataView(new ArrayBuffer(1))
					view.setUint8(0, array ? OBJECT_TAGS.ARRAY : OBJECT_TAGS.RECORD)
					target[PREPARED].insert.run({
						":path": encoded,
						":value": view,
					})

					const t = { ...target, [PROTOTYPE]: array ? Array.prototype : null, [PREFIX]: prefix }
					for (const [k, v] of Object.entries(value)) {
						this.set!(t, k, v, t)
					}
				}
			} catch (err) {
				if (!cycles) {
					database.exec("ROLLBACK")
				}
				throw err
			} finally {
				if (!cycles) {
					target[CYCLES] = undefined
				}
			}

			if (!cycles) {
				database.exec("COMMIT")
			}
			return true
		},

		set(target, prop, value) {
			if (target[PROTOTYPE] === Array.prototype && prop === "length") {
				return this.defineProperty!(target, prop, {
					enumerable: false,
					configurable: false,
					writable: true,
					value,
				})
			} else {
				return this.defineProperty!(target, prop, {
					enumerable: true,
					configurable: true,
					writable: true,
					value,
				})
			}
		},

		deleteProperty(target, prop) {
			if (typeof prop === "symbol") {
				return false
			} else if (target[PROTOTYPE] === Array.prototype && prop === "length") {
				return false
			}

			const prefix = [...target[PREFIX], key(prop)]
			const encoded = encodePath(prefix)

			const result = target[PREPARED].delete.run({
				":lower": encoded,
				":upper": increment(encoded),
			})
			return result.changes > 0
		},

		ownKeys(target) {
			const prefix = target[PREFIX]
			const encoded = encodePath(prefix)

			const rows = target[PREPARED].selectMany.iterate({
				":lower": encoded,
				":upper": increment(encoded),
			})

			return Array.from(
				rows
					.map((row) => {
						const { path } = row as { path: Uint8Array<ArrayBuffer> }
						return decodePath(new DataView(path.buffer))
					})
					.filter((decoded) => decoded.length === prefix.length + 1)
					.map((decoded) => String(decoded.at(-1))),
			)
		},
	})

	return proxied as unknown as Table
}

function key(prop: string): string | number {
	const index = Number(prop)
	if (Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff) {
		return index
	} else {
		return prop
	}
}
