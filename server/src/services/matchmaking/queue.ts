/**
 * Intrusive doubly-linked FIFO with an id index.
 *
 * Why not an array or a Map:
 *  - `Array.shift()` is O(n); with thousands of waiting users that cost lands
 *    on every single match.
 *  - A `Map` iterates in insertion order (which is why the old code appeared to
 *    be FIFO) but removing an entry from the middle still means the caller has
 *    to hunt for it, and there is no way to peek at the head cheaply.
 *
 * Every operation here is O(1) except `toArray`/`scan`, which are O(n) by
 * definition. Crucially, all of them are *synchronous*: the matcher relies on
 * that to treat a whole match as an atomic step (see engine.ts).
 */

export interface QueueNode<T> {
  value: T;
  prev: QueueNode<T> | null;
  next: QueueNode<T> | null;
  /** Guards against a node being removed twice (double-match). */
  removed: boolean;
}

export class FifoQueue<T> {
  private head: QueueNode<T> | null = null;
  private tail: QueueNode<T> | null = null;
  private index = new Map<string, QueueNode<T>>();
  private readonly keyOf: (value: T) => string;

  constructor(keyOf: (value: T) => string) {
    this.keyOf = keyOf;
  }

  get size(): number {
    return this.index.size;
  }

  get isEmpty(): boolean {
    return this.index.size === 0;
  }

  /**
   * Append to the tail. If the key is already queued the existing entry is
   * replaced *in place*, preserving its original queue position — a user who
   * changes filters should not lose the time they already waited, and must not
   * be able to jump the queue by re-joining repeatedly.
   */
  enqueue(value: T): QueueNode<T> {
    const key = this.keyOf(value);
    const existing = this.index.get(key);
    if (existing) {
      existing.value = value;
      return existing;
    }

    const node: QueueNode<T> = { value, prev: this.tail, next: null, removed: false };
    if (this.tail) {
      this.tail.next = node;
    } else {
      this.head = node;
    }
    this.tail = node;
    this.index.set(key, node);
    return node;
  }

  /** Remove and return the oldest entry. */
  dequeue(): T | null {
    if (!this.head) return null;
    const node = this.head;
    this.unlink(node);
    return node.value;
  }

  peek(): T | null {
    return this.head ? this.head.value : null;
  }

  get(key: string): T | null {
    const node = this.index.get(key);
    return node ? node.value : null;
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  /** Remove by key. Returns the removed value, or null if it was not queued. */
  remove(key: string): T | null {
    const node = this.index.get(key);
    if (!node || node.removed) return null;
    this.unlink(node);
    return node.value;
  }

  /**
   * Walk from oldest to newest and remove+return the first entry that
   * `predicate` accepts. This is the FIFO fairness guarantee: whoever has been
   * waiting longest and is compatible wins, never a newer arrival.
   */
  takeFirst(predicate: (value: T) => boolean): T | null {
    let node = this.head;
    while (node) {
      const next = node.next; // capture before any mutation
      if (!node.removed && predicate(node.value)) {
        this.unlink(node);
        return node.value;
      }
      node = next;
    }
    return null;
  }

  /** Oldest-to-newest read-only walk. Return false from `fn` to stop early. */
  scan(fn: (value: T) => boolean | void): void {
    let node = this.head;
    while (node) {
      const next = node.next;
      if (!node.removed && fn(node.value) === false) return;
      node = next;
    }
  }

  /** 0-based position from the head, or -1. O(n) — for display only. */
  positionOf(key: string): number {
    const target = this.index.get(key);
    if (!target || target.removed) return -1;
    let pos = 0;
    let node = this.head;
    while (node) {
      if (node === target) return pos;
      if (!node.removed) pos++;
      node = node.next;
    }
    return -1;
  }

  toArray(): T[] {
    const out: T[] = [];
    let node = this.head;
    while (node) {
      if (!node.removed) out.push(node.value);
      node = node.next;
    }
    return out;
  }

  clear(): void {
    this.head = null;
    this.tail = null;
    this.index.clear();
  }

  private unlink(node: QueueNode<T>): void {
    if (node.removed) return;
    node.removed = true;

    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;

    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;

    node.prev = null;
    // `next` is deliberately preserved. A walk in `scan`/`takeFirst` holds a
    // pointer to this node, and the predicate it invokes is allowed to remove
    // entries — including this one. Nulling `next` here would strand that walk
    // at a dead end and silently skip the rest of the queue. The `removed`
    // flag is what keeps unlinked nodes from being visited; the forward
    // pointer only exists so an in-flight iterator can step past them.
    this.index.delete(this.keyOf(node.value));
  }
}
