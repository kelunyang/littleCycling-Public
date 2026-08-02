/**
 * Cooperative-yield helper for the per-chunk terrain builders.
 *
 * A dense-urban chunk build is thousands of per-feature iterations of pure CPU
 * work — extruding buildings, triangulating landuse, ribboning roads. Run as one
 * synchronous burst it freezes the main thread for hundreds of ms and starves
 * V8's GC (garbage balloons to 2-3x the live set). These builders are already
 * `async`, so we can hand the thread back periodically.
 *
 * `createYielder()` returns a `maybeYield` you call inside a hot loop: it is
 * nearly free until ~`intervalMs` of wall-clock has elapsed since the last real
 * yield, at which point it awaits a macrotask (`setTimeout(0)`) so the browser
 * can paint, handle input, and let GC run, then resets its clock. One yielder
 * per build (share it across a build's loops so the budget is global, not
 * per-loop).
 */

/** A cheap "yield if we've hogged the thread long enough" check. */
export type MaybeYield = () => Promise<void>;

/**
 * ONE clock, shared by every yielder in the process.
 *
 * This used to be a fresh clock per `createYielder()` call, and the comment
 * above told callers to "share it across a build's loops so the budget is
 * global, not per-loop". Nobody did: all seven builders call `createYielder()`
 * themselves, and `terrain-chunk-manager` runs five of them CONCURRENTLY inside
 * one `Promise.all` (roads, waterways, aeroways, buildings, landuse) — plus
 * several chunks may be building at once. Every one of them independently
 * believed it had spent only 10 ms while they were interleaving on the same
 * thread, so the thread could run for the sum of all their budgets between two
 * actual paints. Measured on the N100: frames of 1017 ms with 927 ms of it in
 * JS, every stall within 3 s of a chunk event.
 *
 * A per-build clock cannot fix that either, because concurrent builds would
 * each get one. The thing being rationed is the MAIN THREAD, and there is
 * exactly one of those — so there is exactly one clock. Whoever calls first
 * after the interval yields and resets it for everybody.
 */
let lastYield = performance.now();

/**
 * Make a `maybeYield`. Call it inside per-feature loops; it only actually
 * yields once ~`intervalMs` (default 10ms) of work has piled up since the
 * previous yield **by anyone**.
 *
 * The returned closure is still per-caller so existing call sites are
 * unchanged, but the budget it spends is shared — see the note above.
 */
export function createYielder(intervalMs = 10): MaybeYield {
  return async (): Promise<void> => {
    if (performance.now() - lastYield >= intervalMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  };
}

/**
 * Reset the shared clock. For tests only — production has one continuous
 * thread and therefore one continuous budget.
 */
export function resetYieldClockForTests(): void {
  lastYield = performance.now();
}
