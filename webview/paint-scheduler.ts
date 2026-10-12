/** Coalesce streaming paints without delaying settled output or session switches.
 * The callback reads the latest state, not the state that scheduled the paint.
 */
export class PaintScheduler {
  private frame?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private lastPaint = -Infinity;
  private scope?: string;

  constructor(
    private paint: () => void,
    private intervalMs = 80,
  ) {}

  request(streaming: boolean, scope?: string) {
    const switched = scope !== this.scope;
    this.scope = scope;
    if (!streaming || switched) {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.frame = this.timer = undefined;
    }
    if (this.frame !== undefined || this.timer !== undefined) return;
    const delay =
      streaming && !switched
        ? Math.max(0, this.intervalMs - (performance.now() - this.lastPaint))
        : 0;
    const enqueue = () => {
      this.timer = undefined;
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        this.lastPaint = performance.now();
        this.paint();
      });
    };
    if (delay > 0) this.timer = setTimeout(enqueue, delay);
    else enqueue();
  }
}
