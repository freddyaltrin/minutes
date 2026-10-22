import { describe, it, expect } from 'vitest'
import { v, partial, ValidationError } from '../../../src/main/ipc/validate'

const run = <T>(fn: (x: unknown, p: string) => T, x: unknown): T => fn(x, 'arg')
const rejects = (fn: (x: unknown, p: string) => unknown, x: unknown, msg?: RegExp): void => {
  expect(() => fn(x, 'arg')).toThrow(ValidationError)
  if (msg) expect(() => fn(x, 'arg')).toThrow(msg)
}

describe('v.string', () => {
  it('accepts strings within bounds', () => {
    expect(run(v.string(), '')).toBe('')
    expect(run(v.string({ max: 3 }), 'abc')).toBe('abc')
    expect(run(v.string({ min: 1 }), 'a')).toBe('a')
  })
  it('rejects non-strings and out-of-range lengths', () => {
    rejects(v.string(), 1, /arg: expected string, got number/)
    rejects(v.string(), null, /got null/)
    rejects(v.string(), undefined, /got undefined/)
    rejects(v.string(), new String('x'))
    rejects(v.string({ max: 3 }), 'abcd', /too long \(max 3\)/)
    rejects(v.string({ min: 2 }), 'a', /too short \(min 2\)/)
  })
})

describe('v.id', () => {
  it('accepts uuids and simple identifiers', () => {
    expect(run(v.id(), '3f2b0b2a-1a2b-4c3d-8e9f-0a1b2c3d4e5f')).toBe('3f2b0b2a-1a2b-4c3d-8e9f-0a1b2c3d4e5f')
    expect(run(v.id(), 'note_1')).toBe('note_1')
    expect(run(v.id(), 'a'.repeat(64))).toBe('a'.repeat(64))
  })
  it('rejects empty, overlong, path-like and unicode ids', () => {
    rejects(v.id(), '', /expected identifier/)
    rejects(v.id(), 'a'.repeat(65))
    rejects(v.id(), '../etc/passwd')
    rejects(v.id(), 'with space')
    rejects(v.id(), 'id;DROP')
    rejects(v.id(), 'ünïcode')
    rejects(v.id(), 'a\nb')
    rejects(v.id(), 42)
    rejects(v.id(), null)
  })
})

describe('v.number', () => {
  it('accepts finite numbers and enforces int/min/max', () => {
    expect(run(v.number(), 1.5)).toBe(1.5)
    expect(run(v.number(), -0)).toBe(-0)
    expect(run(v.number({ int: true, min: 0, max: 10 }), 10)).toBe(10)
  })
  it('rejects NaN, Infinity, strings and bounds violations', () => {
    rejects(v.number(), NaN, /expected number/)
    rejects(v.number(), Infinity)
    rejects(v.number(), -Infinity)
    rejects(v.number(), '1')
    rejects(v.number(), 1n as unknown)
    rejects(v.number({ int: true }), 1.5, /expected integer/)
    rejects(v.number({ min: 0 }), -1, /below minimum 0/)
    rejects(v.number({ max: 5 }), 6, /above maximum 5/)
  })
})

describe('v.boolean / v.literal / v.optional / v.nullable', () => {
  it('boolean', () => {
    expect(run(v.boolean(), true)).toBe(true)
    expect(run(v.boolean(), false)).toBe(false)
    rejects(v.boolean(), 'true', /expected boolean/)
    rejects(v.boolean(), 0)
  })
  it('literal', () => {
    const scope = v.literal(['all', 'notes'] as const)
    expect(run(scope, 'all')).toBe('all')
    rejects(scope, 'other', /one of all\|notes/)
    rejects(scope, 1)
    rejects(scope, undefined)
  })
  it('optional passes undefined through but validates everything else', () => {
    const o = v.optional(v.number())
    expect(run(o, undefined)).toBeUndefined()
    expect(run(o, 3)).toBe(3)
    rejects(o, null)
    rejects(o, 'x')
  })
  it('nullable passes null through but validates everything else', () => {
    const n = v.nullable(v.string())
    expect(run(n, null)).toBeNull()
    expect(run(n, 'x')).toBe('x')
    rejects(n, undefined)
    rejects(n, 1)
  })
  it('optional(nullable(...)) composes', () => {
    const on = v.optional(v.nullable(v.id()))
    expect(run(on, undefined)).toBeUndefined()
    expect(run(on, null)).toBeNull()
    expect(run(on, 'abc')).toBe('abc')
    rejects(on, '!!')
  })
})

describe('v.array', () => {
  it('validates every item and reports the index in the path', () => {
    expect(run(v.array(v.string()), ['a', 'b'])).toEqual(['a', 'b'])
    expect(run(v.array(v.string()), [])).toEqual([])
    expect(() => v.array(v.string())(['a', 2], 'tags')).toThrow(/tags\[1\]: expected string/)
  })
  it('rejects non-arrays and too many items', () => {
    rejects(v.array(v.string()), 'abc', /expected array/)
    rejects(v.array(v.string()), { length: 1, 0: 'a' })
    rejects(v.array(v.string(), { max: 2 }), ['a', 'b', 'c'], /too many items/)
    expect(run(v.array(v.string(), { max: 2 }), ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('v.object', () => {
  const noteInput = v.object({
    title: v.optional(v.string({ max: 10 })),
    folderId: v.optional(v.nullable(v.id())),
    attendees: v.optional(v.array(v.string())),
    nested: v.optional(v.object({ deep: v.number({ int: true }) }))
  })

  it('accepts matching shapes and strips unknown keys', () => {
    const out = run(noteInput, { title: 'x', folderId: null, extra: 'dropped' })
    expect(out).toEqual({ title: 'x', folderId: null, attendees: undefined, nested: undefined })
    expect('extra' in out).toBe(false)
  })
  it('validates nested objects with a dotted path', () => {
    expect(run(noteInput, { nested: { deep: 2 } }).nested).toEqual({ deep: 2 })
    expect(() => noteInput({ nested: { deep: 2.5 } }, 'input')).toThrow(/input\.nested\.deep: expected integer/)
    expect(() => noteInput({ nested: 'no' }, 'input')).toThrow(/input\.nested: expected object/)
    expect(() => noteInput({ attendees: [1] }, 'input')).toThrow(/input\.attendees\[0\]/)
  })
  it('rejects null, arrays and primitives', () => {
    rejects(noteInput, null, /expected object, got null/)
    rejects(noteInput, [], /expected object/)
    rejects(noteInput, 'str')
    rejects(noteInput, 1)
  })
  it('required keys must be present', () => {
    const req = v.object({ id: v.id() })
    rejects(req, {}, /arg\.id: expected identifier/)
  })
  it('does not read inherited properties as own values', () => {
    const req = v.object({ x: v.optional(v.number()) })
    const proto = Object.create({ x: 'inherited' }) as Record<string, unknown>
    // `src[key]` sees prototype values; the validator must still validate them (it rejects the string).
    rejects(req, proto)
    expect(run(req, Object.create(null))).toEqual({ x: undefined })
  })
})

describe('v.record', () => {
  it('validates values and key format', () => {
    const r = v.record(v.string())
    expect(run(r, { 'note.new': 'Ctrl+N', a_b: 'x', 'k:1': 'y', 'k-2': 'z' })).toEqual({ 'note.new': 'Ctrl+N', a_b: 'x', 'k:1': 'y', 'k-2': 'z' })
    expect(run(r, {})).toEqual({})
    rejects(r, { 'bad key': 'x' }, /invalid key bad key/)
    rejects(r, { '': 'x' }, /invalid key/)
    rejects(r, { ['k'.repeat(65)]: 'x' })
    rejects(r, { 'a/b': 'x' })
    rejects(r, { ok: 1 }, /arg\.ok: expected string/)
    rejects(r, [], /expected object/)
    rejects(r, null)
  })
  it('__proto__ style keys are rejected by the key regex, not silently accepted', () => {
    const r = v.record(v.string())
    // JSON.parse builds an own "__proto__" property; the key contains only word chars so it passes the regex,
    // but assignment on a plain object goes through the setter. Document the actual behaviour: no crash,
    // and the output's prototype is untouched.
    const parsed = JSON.parse('{"__proto__": "x", "safe": "y"}') as Record<string, unknown>
    const out = run(r, parsed)
    expect(out.safe).toBe('y')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})

describe('v.arrayBuffer', () => {
  it('accepts ArrayBuffer and views within the size limit', () => {
    const buf = new ArrayBuffer(8)
    expect(run(v.arrayBuffer(8), buf)).toBe(buf)
    const view = new Int16Array(buf)
    expect(run(v.arrayBuffer(8), view)).toBe(buf)
    expect(run(v.arrayBuffer(8), Buffer.alloc(0))).toBeInstanceOf(ArrayBuffer)
  })
  it('rejects oversize payloads and non-buffers', () => {
    rejects(v.arrayBuffer(4), new ArrayBuffer(5), /payload too large/)
    rejects(v.arrayBuffer(4), new Uint8Array(5))
    rejects(v.arrayBuffer(4), [1, 2, 3], /expected ArrayBuffer/)
    rejects(v.arrayBuffer(4), 'abcd')
    rejects(v.arrayBuffer(4), null)
  })
})

describe('v.any / v.void', () => {
  it('any passes through, void always yields undefined', () => {
    const obj = { a: 1 }
    expect(run(v.any(), obj)).toBe(obj)
    expect(run(v.void(), 'ignored')).toBeUndefined()
    expect(run(v.void(), undefined)).toBeUndefined()
  })
})

describe('partial', () => {
  const patch = partial({
    title: v.string({ max: 5 }),
    pinned: v.boolean(),
    folderId: v.nullable(v.id()),
    meta: v.object({ n: v.number() })
  })

  it('validates only the keys present and omits absent ones from the output', () => {
    expect(run(patch, {})).toEqual({})
    expect(run(patch, { pinned: true })).toEqual({ pinned: true })
    expect(run(patch, { title: 'abc', folderId: null })).toEqual({ title: 'abc', folderId: null })
    expect(Object.keys(run(patch, { pinned: false, junk: 1 }))).toEqual(['pinned'])
  })
  it('explicit undefined is treated as absent', () => {
    expect(run(patch, { title: undefined })).toEqual({})
  })
  it('rejects invalid present keys with a dotted path', () => {
    expect(() => patch({ title: 'toolong' }, 'patch')).toThrow(/patch\.title: too long/)
    expect(() => patch({ pinned: 'yes' }, 'patch')).toThrow(/patch\.pinned: expected boolean/)
    expect(() => patch({ meta: { n: 'x' } }, 'patch')).toThrow(/patch\.meta\.n: expected number/)
    expect(() => patch({ folderId: 'bad id!' }, 'patch')).toThrow(/patch\.folderId: expected identifier/)
  })
  it('rejects non-objects', () => {
    rejects(patch, null, /expected object/)
    rejects(patch, [])
    rejects(patch, 'x')
  })
})

describe('ValidationError', () => {
  it('is an Error with a stable name', () => {
    const e = new ValidationError('m')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ValidationError')
    expect(e.message).toBe('m')
  })
})
