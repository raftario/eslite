import path from "node:path"
import test from "node:test"

import Database from "../src/index.ts"

using db = new Database(path.join(import.meta.dirname, "test.db"))

await test(Database.name, async (t) => {
	await t.test("simple", (t) => {
		const table = db.table("simple") as Record<number, number>

		table[0] = 1
		table[1] = 2
		table[2] = table[0] + table[1]

		t.assert.equal(Object.getPrototypeOf(table), null)
		t.assert.deepEqual(table, { 0: 1, 1: 2, 2: 3 })
	})

	await t.test("complex", (t) => {
		const table = db.table("complex")

		const complex = {
			null: null,
			true: true,
			false: false,
			e: Math.E,
			hello: "world",
			biiig: 1_000_000_000_000_000_000n,
			now: new Date(),
			hex: /0x[a-z0-9]+/i,
			nested: [{ values: [null] }],
		}
		table[0] = complex

		t.assert.notEqual(table[0], complex)
		t.assert.deepEqual(table[0], complex)
	})

	await t.test("array", (t) => {
		const table = db.table("array") as Record<string, number[]>

		table.ints = [0, 1, 2]
		table.ints.push(3)
		table.evens = table.ints.filter((n) => n % 2 === 0)

		t.assert.equal(Array.isArray(table.ints), true)
		t.assert.deepEqual(table.ints, [0, 1, 2, 3])
		t.assert.equal(Array.isArray(table.evens), true)
		t.assert.deepEqual(table.evens, [0, 2])
	})
})
