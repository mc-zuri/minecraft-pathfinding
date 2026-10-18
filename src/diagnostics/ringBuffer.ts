/** A fixed-size buffer of the last `capacity` items pushed, the oldest dropped first. */
export class RingBuffer<T> {
  private readonly items: Array<T | undefined>
  private start = 0
  private count = 0

  constructor (public readonly capacity: number) {
    if (!(capacity > 0)) throw new Error(`RingBuffer: capacity must be positive, got ${capacity}`)
    this.items = new Array(capacity)
  }

  get size (): number {
    return this.count
  }

  push (item: T): void {
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = item
      this.count++
      return
    }
    this.items[this.start] = item
    this.start = (this.start + 1) % this.capacity
  }

  /** the newest item, or the one `back` before it */
  last (back = 0): T | undefined {
    if (back < 0 || back >= this.count) return undefined
    return this.items[(this.start + this.count - 1 - back) % this.capacity]
  }

  /** the items, oldest first */
  toArray (): T[] {
    const out: T[] = []
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T)
    return out
  }

  clear (): void {
    this.items.fill(undefined)
    this.start = 0
    this.count = 0
  }
}
