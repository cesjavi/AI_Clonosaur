/** Minimal pub/sub standing in for Tauri's event system in the web build:
 * ported commands that used to `app.emit(...)` (e.g. streaming chat deltas)
 * call `emit` here, and `invoke.ts`'s `listen` wires it to the same
 * `EventCallback` shape Tauri's real `listen` delivers. */
type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

export function emit(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) {
    handler(payload);
  }
}

export function on(event: string, handler: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  return () => {
    handlers.get(event)?.delete(handler);
  };
}
