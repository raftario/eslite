import type { Scalar } from "./index.ts"
import type { Path } from "./internal.ts"

const PATH_TAGS = {
	NUMBER: 0,
	STRING: 1,
}
const VALUE_TAGS = {
	NULL: 0,
	TRUE: 1,
	FALSE: 2,
	NUMBER: 3,
	STRING: 4,
	BIGINT: 5,
	DATE: 6,
	REGEXP: 7,
}

export function increment(prefix: DataView): DataView {
	if (prefix.byteLength === 0) {
		return new DataView(Uint8Array.from([1]).buffer)
	}

	const copy = new Uint8Array(new ArrayBuffer(prefix.byteLength))
	copy.set(new Uint8Array(prefix.buffer))
	copy[copy.length - 1]! += 1
	return new DataView(copy.buffer)
}

export function encodePath(path: Path): DataView {
	const view = new DataView(new ArrayBuffer(0, { maxByteLength: 65535 }))
	for (const segment of path) {
		const offset = view.byteLength
		switch (typeof segment) {
			case "number": {
				view.buffer.resize(offset + 1 + 4)
				view.setUint8(offset, PATH_TAGS.NUMBER)
				view.setUint32(offset + 1, segment)
				break
			}
			case "string": {
				view.buffer.resize(offset + 1 + segment.length * 2 + 2)
				view.setUint8(offset, PATH_TAGS.STRING)
				encodeString(segment, view, offset + 1)
				view.setUint16(offset + 1 + segment.length * 2, 0xfffe)
				break
			}
		}
	}
	return view
}

export function decodePath(from: DataView): Path {
	const path: Path = []
	for (let i = 0; i < from.byteLength; ) {
		switch (from.getUint8(i)) {
			case PATH_TAGS.NUMBER: {
				path.push(from.getUint32(i + 1))
				i += 1 + 4
				break
			}
			case PATH_TAGS.STRING: {
				const segment = String.fromCharCode(...decodeString(from, i + 1))
				path.push(segment)
				i += 1 + segment.length * 2 + 2
				break
			}
			default: {
				throw new TypeError("Unknown data type")
			}
		}
	}
	return path
}

export function encodeValue(value: Scalar): DataView {
	switch (typeof value) {
		case "boolean": {
			const view = new DataView(new ArrayBuffer(1))
			view.setUint8(0, value ? VALUE_TAGS.TRUE : VALUE_TAGS.FALSE)
			return view
		}
		case "number": {
			const view = new DataView(new ArrayBuffer(1 + 8))
			view.setUint8(0, VALUE_TAGS.NUMBER)
			view.setFloat64(1, value)
			return view
		}
		case "string": {
			const view = new DataView(new ArrayBuffer(1 + value.length * 2))
			view.setUint8(0, VALUE_TAGS.STRING)
			encodeString(value, view, 1)
			return view
		}
		case "bigint": {
			const s = value.toString()
			const view = new DataView(new ArrayBuffer(1 + s.length * 2))
			view.setUint8(0, VALUE_TAGS.BIGINT)
			encodeString(s, view, 1)
			return view
		}
		case "object": {
			if (value === null) {
				return new DataView(new ArrayBuffer(1))
			} else if (value instanceof Date) {
				const n = Number(value)
				const view = new DataView(new ArrayBuffer(1 + 8))
				view.setUint8(0, VALUE_TAGS.DATE)
				view.setFloat64(1, n)
				return view
			} else if (value instanceof RegExp) {
				const s = value.toString()
				const view = new DataView(new ArrayBuffer(1 + s.length * 2))
				view.setUint8(0, VALUE_TAGS.REGEXP)
				encodeString(s, view, 1)
				return view
			} else {
				throw new TypeError("Unsupported data type")
			}
		}
		default: {
			throw new TypeError("Unsupported data type")
		}
	}
}

export function decodeValue(from: DataView): Scalar {
	switch (from.getUint8(0)) {
		case VALUE_TAGS.NULL: {
			return null
		}
		case VALUE_TAGS.TRUE: {
			return true
		}
		case VALUE_TAGS.FALSE: {
			return false
		}
		case VALUE_TAGS.NUMBER: {
			return from.getFloat64(1)
		}
		case VALUE_TAGS.STRING: {
			return String.fromCharCode(...decodeString(from, 1))
		}
		case VALUE_TAGS.BIGINT: {
			const s = String.fromCharCode(...decodeString(from, 1))
			return BigInt(s)
		}
		case VALUE_TAGS.DATE: {
			const n = from.getFloat64(1)
			return new Date(n)
		}
		case VALUE_TAGS.REGEXP: {
			const s = String.fromCharCode(...decodeString(from, 1))
			return new RegExp(s)
		}
		default: {
			throw new RangeError("Unknown data type")
		}
	}
}

function encodeString(s: string, into: DataView, offset: number) {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i)
		if (code >= 0xfffe) throw new RangeError("Invalid UTF-16 code unit")

		into.setUint16(i * 2 + offset, code)
	}
}

function* decodeString(from: DataView, offset: number) {
	let i: number
	for (i = offset; i < from.buffer.byteLength; i += 2) {
		const code = from.getUint16(i)
		if (code >= 0xfffe) break

		yield code
	}

	return i
}
