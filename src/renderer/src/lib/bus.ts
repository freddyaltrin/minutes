/** Minimal in-renderer event bus used to route shortcut ids and capture commands to the component that owns them. */
type Handler = (payload?: unknown) => void
const handlers = new Map<string, Set<Handler>>()

export const bus = {
  on(id: string, h: Handler): () => void {
    let set = handlers.get(id)
    if (!set) {
      set = new Set()
      handlers.set(id, set)
    }
    set.add(h)
    return () => set!.delete(h)
  },
  emit(id: string, payload?: unknown): boolean {
    const set = handlers.get(id)
    if (!set || set.size === 0) return false
    set.forEach((h) => h(payload))
    return true
  }
}
