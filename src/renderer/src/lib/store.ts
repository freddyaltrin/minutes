import { useSyncExternalStore } from 'react'

/** A tiny external store: immutable state, shallow selectors, no dependencies. */
export function createStore<T extends object>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  const get = (): T => state
  const set = (patch: Partial<T> | ((s: T) => Partial<T>)): void => {
    const p = typeof patch === 'function' ? patch(state) : patch
    let changed = false
    for (const k of Object.keys(p) as (keyof T)[]) {
      if (!Object.is(state[k], p[k])) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...p }
    listeners.forEach((l) => l())
  }
  const subscribe = (l: () => void): (() => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
  function use<U>(selector: (s: T) => U): U {
    return useSyncExternalStore(subscribe, () => selector(state), () => selector(state))
  }
  return { get, set, subscribe, use }
}
