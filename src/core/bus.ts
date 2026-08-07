/**
 * Typed pub/sub. Subsystems talk through this and never import each other.
 *
 * Listener removal happens on the NEXT emit rather than mid-dispatch, because a
 * handler that unsubscribes itself while the list is being walked otherwise
 * skips the following handler — a bug that shows up as "the third particle
 * system stopped working when I added a fourth".
 */
export class EventBusImpl {
  private map = new Map<string, Set<(p: unknown) => void>>();

  on<T = unknown>(event: string, fn: (payload: T) => void): () => void {
    let set = this.map.get(event);
    if (!set) { set = new Set(); this.map.set(event, set); }
    set.add(fn as (p: unknown) => void);
    return () => { set!.delete(fn as (p: unknown) => void); };
  }

  emit<T = unknown>(event: string, payload?: T): void {
    const set = this.map.get(event);
    if (!set || set.size === 0) return;
    // Snapshot: a handler may subscribe or unsubscribe during dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload as unknown);
      } catch (err) {
        // One broken listener must not stop the frame. Report and continue —
        // a silently swallowed error here is invisible for hours.
        console.error(`[bus] listener for "${event}" threw:`, err);
      }
    }
  }

  clear(): void { this.map.clear(); }
}
