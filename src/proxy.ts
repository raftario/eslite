import type { DatabaseSync, StatementSync } from "node:sqlite"
import { type CustomInspectFunction, inspect } from "node:util"

import {
	datatype,
	decodePath,
	decodeScalar,
	encodeComplex,
	encodePath,
	encodeScalar,
	increment,
	type Path,
} from "./encoding.ts"
import { type Complex, Database, type Scalar, type Table } from "./index.ts"

export const CYCLES = Symbol("cycles")
export const DATABASE = Symbol("database")
export const PREFIX = Symbol("prefix")
export const PREPARED = Symbol("prepared")
export const PROTOTYPE = Symbol("prototype")

export interface Inner {
	[PROTOTYPE]: null | typeof Array.prototype
	[PREFIX]: Path

	[DATABASE]: DatabaseSync
	[PREPARED]: {
		selectOne: StatementSync
		selectMany: StatementSync
		insert: StatementSync
		delete: StatementSync
		length: StatementSync
	}

	[CYCLES]?: WeakSet<object>

	[inspect.custom]: CustomInspectFunction
}

export function key(prop: string): string | number {
	const index = Number(prop)
	if (Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff) {
		return index
	} else {
		return prop
	}
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
		[PREFIX]: [],

		[DATABASE]: database,
		[PREPARED]: {
			selectOne: database.prepare(`SELECT value FROM ${table} WHERE path == :path`),
			selectMany: database.prepare(
				`SELECT path, value FROM ${table} WHERE path >= :lower AND path < :upper`,
			),
			insert: database.prepare(`INSERT INTO ${table} (path, value) VALUES (:path, :value)`),
			delete: database.prepare(`DELETE FROM ${table} WHERE path >= :lower AND path < :upper`),
			length: database.prepare(`
				SELECT path FROM ${table}
				WHERE LENGTH(path) == LENGTH(:lower) AND path >= :lower AND path < :upper
				ORDER BY path DESC LIMIT 1
			`),
		},

		[inspect.custom](depth, options) {
			const base = this[PROTOTYPE] === Array.prototype ? [] : {}
			inspect(
				Object.assign(base, Object.fromEntries(Database.entries(this as unknown as Complex))),
				Object.assign(options, { depth }),
			)
		},
	})
}

export function instanciate(from: DataView, inner: Inner, prefix: Path): Scalar | Complex {
	switch (datatype(from)) {
		case "record": {
			return proxy(
				Object.assign(
					{},
					{
						[PROTOTYPE]: null,
						[PREFIX]: prefix,
						[DATABASE]: inner[DATABASE],
						[PREPARED]: inner[PREPARED],
						[inspect.custom]: inner[inspect.custom],
					},
				),
			)
		}
		case "array": {
			return proxy(
				Object.assign([], {
					[PROTOTYPE]: Array.prototype,
					[PREFIX]: prefix,
					[DATABASE]: inner[DATABASE],
					[PREPARED]: inner[PREPARED],
					[inspect.custom]: inner[inspect.custom],
				}),
			)
		}
		default: {
			return decodeScalar(from)
		}
	}
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

		getOwnPropertyDescriptor(this: ProxyHandler<Inner>, target, prop) {
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
			return {
				enumerable: true,
				configurable: true,
				writable: true,
				value: instanciate(new DataView(value.buffer), target, prefix),
			}
		},

		get(this: ProxyHandler<Inner>, target, prop, receiver) {
			const descriptor = this.getOwnPropertyDescriptor!(target, prop)
			if (descriptor !== undefined) {
				return descriptor.value
			}

			// Fallback to prototype chain
			const proto = target[PROTOTYPE]
			if (proto === null) {
				return undefined
			}
			return Reflect.get(proto, prop, receiver)
		},

		has(this: ProxyHandler<Inner>, target, prop) {
			const descriptor = this.getOwnPropertyDescriptor!(target, prop)
			if (descriptor !== undefined) {
				return true
			}

			// Fallback to prototype chain
			const proto = target[PROTOTYPE]
			if (proto === null) {
				return false
			}
			return Reflect.has(proto, prop)
		},

		defineProperty(this: ProxyHandler<Inner>, target, prop, desc) {
			const value = desc.value
			if (typeof prop === "symbol") {
				// We only allow reading symbol properties, not defining them
				return false
			} else if (value === undefined) {
				// We implement setting to undefined as deleting
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
						":value": encodeScalar(value),
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

					target[PREPARED].insert.run({
						":path": encoded,
						":value": encodeComplex(array ? "array" : "record"),
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

		set(this: ProxyHandler<Inner>, target, prop, value) {
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

		deleteProperty(this: ProxyHandler<Inner>, target, prop) {
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
			const keys = []

			// Arrays must returns "length" here when proxied
			if (target[PROTOTYPE] === Array.prototype) {
				keys.push("length")
			}

			keys.push(...Database.entries(target as unknown as Complex).map(([key]) => String(key)))
			return keys
		},
	})

	return proxied as unknown as Table
}
