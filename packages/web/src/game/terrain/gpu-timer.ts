/**
 * Real GPU time per frame, via `EXT_disjoint_timer_query_webgl2`.
 *
 * ── Why this exists ──
 *
 * **Nothing in this project has ever measured GPU time.** Every claim about a
 * GPU bottleneck has been inferred from `avgOutsideMs`, which is a RESIDUAL:
 * wall-clock minus `useTerrainRenderer.render()`. That residual also contains
 * 60 Hz Vue reactivity redrawing the HUD, an SVG minimap whose filtered
 * transforms are rewritten every frame, a `backdrop-filter` over a live canvas,
 * two more rAF loops, chunk-build slices, and GC.
 *
 * Reading it as "the GPU" produced a confident, wrong conclusion that stood for
 * weeks: gameview was called fill-rate bound at "7× the demo's per-pixel cost",
 * and a whole optimisation plan was written against it. The falsifier was
 * already in the logs — one session, same code, same tier, medians of 31.3 ms
 * at 0.84, 1.24 AND 2.26 Mpx. See `plan/render-mechanism-comparison.md`.
 *
 * So: measure it, and stop guessing.
 *
 * ── How the extension actually behaves ──
 *
 * Timer queries are asynchronous. `endQuery` does not give you a number; the
 * result lands some frames later and must be polled. Three rules the spec
 * imposes and this class obeys:
 *
 *  1. **One `TIME_ELAPSED` query may be active at a time.** A second `beginQuery`
 *     before the first ends is an INVALID_OPERATION, so a frame that begins a
 *     query must end it — hence `begin()`/`end()` are paired and `end()` is
 *     safe to call when `begin()` declined.
 *  2. **`GPU_DISJOINT_EXT` invalidates results.** The GPU can be preempted (a
 *     context switch, a power-state change); when that happens every in-flight
 *     result is meaningless and must be thrown away, not averaged in. On a
 *     laptop or an N100 this fires regularly.
 *  3. **A result is only readable once `QUERY_RESULT_AVAILABLE` is true.**
 *     Blocking on it would stall the pipeline and destroy the thing being
 *     measured, so this polls and accepts the latency.
 *
 * ── Availability ──
 *
 * The extension is frequently absent — it is a fingerprinting vector, so
 * browsers gate it (it is unavailable in most cross-origin-isolated and
 * privacy-hardened contexts, and was disabled entirely in Chrome for a period).
 *
 * When it is missing this reports `null`, **never 0**. "The GPU took no time"
 * and "nobody measured the GPU" are opposite findings, and collapsing them is
 * exactly the error this file exists to end.
 */

/** One second's worth of GPU timings, or nulls when unmeasurable. */
export interface GpuTimings {
  /** Mean GPU ms over the samples that came back clean, or null. */
  avgGpuMs: number | null;
  /** Median — a hitch and a slowdown look identical in a mean. */
  p50GpuMs: number | null;
  p95GpuMs: number | null;
  /** How many frames produced a usable number. */
  gpuSamples: number;
  /** Frames whose result was thrown away because the GPU was preempted. */
  gpuDisjointDrops: number;
  /**
   * Why there is no number, when there is none. Distinguishing "extension
   * missing" from "results not back yet" matters: the first is permanent and
   * the second resolves in a frame or two.
   */
  gpuStatus: 'ok' | 'unsupported' | 'no-webgl2' | 'pending';
}

const EMPTY: GpuTimings = {
  avgGpuMs: null, p50GpuMs: null, p95GpuMs: null,
  gpuSamples: 0, gpuDisjointDrops: 0, gpuStatus: 'unsupported',
};

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private status: GpuTimings['gpuStatus'] = 'unsupported';

  /** Queries handed to the driver, oldest first. */
  private inFlight: WebGLQuery[] = [];
  /** The query this frame opened, if any. */
  private active: WebGLQuery | null = null;
  private samples: number[] = [];
  private disjointDrops = 0;

  /**
   * `renderer` is a THREE.WebGLRenderer; typed loosely so this module stays
   * free of a three import (it needs one method and one constant).
   */
  constructor(renderer: { getContext(): WebGLRenderingContext | WebGL2RenderingContext }) {
    const gl = renderer.getContext();
    // WebGL1's timer extension has a different, more awkward contract and
    // three has rendered on WebGL2 everywhere since r163 — not worth two paths.
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      this.status = 'no-webgl2';
      return;
    }
    this.gl = gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    if (!ext) {
      // Expected on many machines. Not an error, and NOT zero.
      this.status = 'unsupported';
      return;
    }
    this.ext = ext;
    this.status = 'pending';
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** Open a query around this frame's draw calls. No-op when unsupported. */
  begin(): void {
    const { gl, ext } = this;
    if (!gl || !ext || this.active) return;
    // Cap the queue. If results stop coming back (a driver that never signals
    // availability), an uncapped queue leaks a WebGLQuery every frame.
    if (this.inFlight.length >= 8) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  /** Close this frame's query and harvest whatever has landed. */
  end(): void {
    const { gl, ext } = this;
    if (!gl || !ext) return;
    if (this.active) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.inFlight.push(this.active);
      this.active = null;
    }

    // A disjoint event invalidates EVERY in-flight result, not just the newest
    // — the flag is sticky since it was last read, so it covers the whole
    // window. Reading it also clears it.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      for (const q of this.inFlight) gl.deleteQuery(q);
      this.disjointDrops += this.inFlight.length;
      this.inFlight.length = 0;
      return;
    }

    // Harvest from the front: queries complete in order, so the first that is
    // not ready ends the sweep.
    while (this.inFlight.length) {
      const q = this.inFlight[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.inFlight.shift();
      gl.deleteQuery(q);
      this.samples.push(ns / 1e6);   // ns → ms
    }
  }

  /**
   * Drain the second's samples into a report. Call where the perf record is
   * assembled; it resets the accumulators like the other counters there.
   */
  takeTimings(): GpuTimings {
    if (!this.ext) return { ...EMPTY, gpuStatus: this.status };
    const s = this.samples;
    const drops = this.disjointDrops;
    this.samples = [];
    this.disjointDrops = 0;
    if (!s.length) {
      return { ...EMPTY, gpuStatus: 'pending', gpuDisjointDrops: drops };
    }
    const sorted = [...s].sort((a, b) => a - b);
    const at = (q: number) => +(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]).toFixed(2);
    return {
      avgGpuMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
      p50GpuMs: at(0.5),
      p95GpuMs: at(0.95),
      gpuSamples: s.length,
      gpuDisjointDrops: drops,
      gpuStatus: 'ok',
    };
  }

  dispose(): void {
    const { gl } = this;
    if (!gl) return;
    for (const q of this.inFlight) gl.deleteQuery(q);
    this.inFlight.length = 0;
    this.active = null;
  }
}
