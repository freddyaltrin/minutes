// Minimal runtime validation for IPC payloads. Every handler validates its arguments
// before touching the database or file system. Fails closed on unexpected shapes.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export type Validator<T> = (value: unknown, path: string) => T

const fail = (path: string, expected: string, value: unknown): never => {
  throw new ValidationError(`${path}: expected ${expected}, got ${value === null ? 'null' : typeof value}`)
}

export const v = {
  string:
    (opts: { max?: number; min?: number } = {}): Validator<string> =>
    (x, p) => {
      if (typeof x !== 'string') return fail(p, 'string', x)
      if (opts.max !== undefined && x.length > opts.max) throw new ValidationError(`${p}: too long (max ${opts.max})`)
      if (opts.min !== undefined && x.length < opts.min) throw new ValidationError(`${p}: too short (min ${opts.min})`)
      return x
    },
  id: (): Validator<string> => (x, p) => {
    if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x)) return fail(p, 'identifier', x)
    return x
  },
  number:
    (opts: { min?: number; max?: number; int?: boolean } = {}): Validator<number> =>
    (x, p) => {
      if (typeof x !== 'number' || !Number.isFinite(x)) return fail(p, 'number', x)
      if (opts.int && !Number.isInteger(x)) throw new ValidationError(`${p}: expected integer`)
      if (opts.min !== undefined && x < opts.min) throw new ValidationError(`${p}: below minimum ${opts.min}`)
      if (opts.max !== undefined && x > opts.max) throw new ValidationError(`${p}: above maximum ${opts.max}`)
      return x
    },
  boolean: (): Validator<boolean> => (x, p) => (typeof x === 'boolean' ? x : fail(p, 'boolean', x)),
  literal:
    <const T extends readonly string[]>(values: T): Validator<T[number]> =>
    (x, p) => {
      if (typeof x !== 'string' || !values.includes(x)) return fail(p, `one of ${values.join('|')}`, x)
      return x as T[number]
    },
  optional:
    <T>(inner: Validator<T>): Validator<T | undefined> =>
    (x, p) =>
      x === undefined ? undefined : inner(x, p),
  nullable:
    <T>(inner: Validator<T>): Validator<T | null> =>
    (x, p) =>
      x === null ? null : inner(x, p),
  array:
    <T>(inner: Validator<T>, opts: { max?: number } = {}): Validator<T[]> =>
    (x, p) => {
      if (!Array.isArray(x)) return fail(p, 'array', x)
      if (opts.max !== undefined && x.length > opts.max) throw new ValidationError(`${p}: too many items`)
      return x.map((item, i) => inner(item, `${p}[${i}]`))
    },
  object:
    <S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: ReturnType<S[K]> }> =>
    (x, p) => {
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return fail(p, 'object', x)
      const out: Record<string, unknown> = {}
      const src = x as Record<string, unknown>
      for (const key of Object.keys(shape)) {
        out[key] = shape[key](src[key], `${p}.${key}`)
      }
      return out as { [K in keyof S]: ReturnType<S[K]> }
    },
  record:
    <T>(inner: Validator<T>): Validator<Record<string, T>> =>
    (x, p) => {
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return fail(p, 'object', x)
      const out: Record<string, T> = {}
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(k)) throw new ValidationError(`${p}: invalid key ${k}`)
        out[k] = inner(val, `${p}.${k}`)
      }
      return out
    },
  arrayBuffer:
    (maxBytes: number): Validator<ArrayBuffer> =>
    (x, p) => {
      if (!(x instanceof ArrayBuffer) && !ArrayBuffer.isView(x)) return fail(p, 'ArrayBuffer', x)
      const buf = x instanceof ArrayBuffer ? x : (x as ArrayBufferView).buffer
      if (buf.byteLength > maxBytes) throw new ValidationError(`${p}: payload too large`)
      return buf as ArrayBuffer
    },
  any: (): Validator<unknown> => (x) => x,
  void: (): Validator<undefined> => () => undefined
}

/** Deep-partial object validator: only validates keys present. */
export const partial =
  <S extends Record<string, Validator<unknown>>>(shape: S): Validator<Partial<{ [K in keyof S]: ReturnType<S[K]> }>> =>
  (x, p) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return fail(p, 'object', x)
    const out: Record<string, unknown> = {}
    const src = x as Record<string, unknown>
    for (const key of Object.keys(shape)) {
      if (src[key] !== undefined) out[key] = shape[key](src[key], `${p}.${key}`)
    }
    return out as Partial<{ [K in keyof S]: ReturnType<S[K]> }>
  }
