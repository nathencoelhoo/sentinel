/**
 * Bounded FIFO with drop-oldest backpressure. When producers outpace the consumer, the
 * oldest items are discarded (and counted) instead of growing memory without bound.
 */
export class BoundedQueue<T> {
  readonly capacity: number;
  dropped = 0;
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array<T | undefined>(capacity);
  }
  get length(): number {
    return this.count;
  }
  push(item: T): void {
    if (this.count === this.capacity) {
      this.buf[this.head] = item; // overwrite oldest
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
      return;
    }
    this.buf[(this.head + this.count) % this.capacity] = item;
    this.count++;
  }
  /** Remove and return up to `max` items, oldest first. */
  drain(max = Infinity): T[] {
    const n = Math.min(max, this.count);
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.head] as T;
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
    }
    this.count -= n;
    return out;
  }
}
