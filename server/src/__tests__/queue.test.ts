import { describe, it, expect, beforeEach } from "vitest";
import { FifoQueue } from "../services/matchmaking/queue";

interface Item {
  id: string;
  n: number;
}

const item = (id: string, n = 0): Item => ({ id, n });

describe("FifoQueue", () => {
  let q: FifoQueue<Item>;

  beforeEach(() => {
    q = new FifoQueue<Item>((v) => v.id);
  });

  describe("basic ordering", () => {
    it("dequeues in insertion order", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.enqueue(item("c"));

      expect(q.dequeue()?.id).toBe("a");
      expect(q.dequeue()?.id).toBe("b");
      expect(q.dequeue()?.id).toBe("c");
      expect(q.dequeue()).toBeNull();
    });

    it("reports size and emptiness", () => {
      expect(q.isEmpty).toBe(true);
      expect(q.size).toBe(0);
      q.enqueue(item("a"));
      expect(q.isEmpty).toBe(false);
      expect(q.size).toBe(1);
    });

    it("peek does not consume", () => {
      q.enqueue(item("a"));
      expect(q.peek()?.id).toBe("a");
      expect(q.peek()?.id).toBe("a");
      expect(q.size).toBe(1);
    });

    it("peek and dequeue on an empty queue return null", () => {
      expect(q.peek()).toBeNull();
      expect(q.dequeue()).toBeNull();
    });
  });

  describe("re-enqueue", () => {
    it("keeps the original position so waiting time is not lost", () => {
      q.enqueue(item("a", 1));
      q.enqueue(item("b", 1));
      q.enqueue(item("c", 1));

      // "a" updates its filters — it must stay at the head.
      q.enqueue(item("a", 99));

      expect(q.size).toBe(3);
      expect(q.toArray().map((v) => v.id)).toEqual(["a", "b", "c"]);
      expect(q.get("a")?.n).toBe(99);
    });

    it("cannot be used to jump the queue by re-joining", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      for (let i = 0; i < 10; i++) q.enqueue(item("b"));
      expect(q.toArray().map((v) => v.id)).toEqual(["a", "b"]);
    });
  });

  describe("removal", () => {
    it("removes from the head", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      expect(q.remove("a")?.id).toBe("a");
      expect(q.toArray().map((v) => v.id)).toEqual(["b"]);
    });

    it("removes from the tail", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      expect(q.remove("b")?.id).toBe("b");
      expect(q.toArray().map((v) => v.id)).toEqual(["a"]);
    });

    it("removes from the middle and relinks both neighbours", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.enqueue(item("c"));
      q.remove("b");
      expect(q.toArray().map((v) => v.id)).toEqual(["a", "c"]);
      expect(q.dequeue()?.id).toBe("a");
      expect(q.dequeue()?.id).toBe("c");
    });

    it("returns null for an unknown key", () => {
      expect(q.remove("nope")).toBeNull();
    });

    it("is idempotent — a double remove does not corrupt the list", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      expect(q.remove("a")?.id).toBe("a");
      expect(q.remove("a")).toBeNull();
      expect(q.size).toBe(1);
      expect(q.dequeue()?.id).toBe("b");
    });

    it("emptying via remove leaves a reusable queue", () => {
      q.enqueue(item("a"));
      q.remove("a");
      expect(q.isEmpty).toBe(true);
      q.enqueue(item("z"));
      expect(q.dequeue()?.id).toBe("z");
    });
  });

  describe("takeFirst", () => {
    it("returns the oldest match, not any match", () => {
      q.enqueue(item("a", 1));
      q.enqueue(item("b", 2));
      q.enqueue(item("c", 2));

      const taken = q.takeFirst((v) => v.n === 2);
      expect(taken?.id).toBe("b");
      expect(q.toArray().map((v) => v.id)).toEqual(["a", "c"]);
    });

    it("returns null and mutates nothing when nothing matches", () => {
      q.enqueue(item("a", 1));
      expect(q.takeFirst((v) => v.n === 42)).toBeNull();
      expect(q.size).toBe(1);
    });

    it("survives a predicate that removes entries mid-walk", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.enqueue(item("c"));

      const taken = q.takeFirst((v) => {
        if (v.id === "a") {
          q.remove("b"); // predicate mutates the list underneath the walk
          return false;
        }
        return true;
      });

      expect(taken?.id).toBe("c");
      expect(q.toArray().map((v) => v.id)).toEqual(["a"]);
    });
  });

  describe("positionOf", () => {
    it("is 0-based from the head", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.enqueue(item("c"));
      expect(q.positionOf("a")).toBe(0);
      expect(q.positionOf("c")).toBe(2);
    });

    it("returns -1 for an absent key", () => {
      expect(q.positionOf("ghost")).toBe(-1);
    });

    it("shifts after a removal", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.enqueue(item("c"));
      q.remove("a");
      expect(q.positionOf("b")).toBe(0);
      expect(q.positionOf("c")).toBe(1);
    });
  });

  describe("scan", () => {
    it("walks oldest first", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      const seen: string[] = [];
      q.scan((v) => void seen.push(v.id));
      expect(seen).toEqual(["a", "b"]);
    });

    it("stops early on false", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.enqueue(item("c"));
      const seen: string[] = [];
      q.scan((v) => {
        seen.push(v.id);
        return v.id !== "b";
      });
      expect(seen).toEqual(["a", "b"]);
    });
  });

  describe("clear", () => {
    it("empties and stays usable", () => {
      q.enqueue(item("a"));
      q.enqueue(item("b"));
      q.clear();
      expect(q.size).toBe(0);
      expect(q.peek()).toBeNull();
      q.enqueue(item("c"));
      expect(q.dequeue()?.id).toBe("c");
    });
  });

  describe("scale", () => {
    it("keeps strict FIFO across 10k interleaved operations", () => {
      const N = 10_000;
      for (let i = 0; i < N; i++) q.enqueue(item(`u${i}`, i));

      // Remove every third entry.
      for (let i = 0; i < N; i += 3) q.remove(`u${i}`);

      const remaining = q.toArray().map((v) => v.n);
      expect(remaining.length).toBe(N - Math.ceil(N / 3));

      // Still strictly ascending — the linked list never got out of order.
      for (let i = 1; i < remaining.length; i++) {
        expect(remaining[i]).toBeGreaterThan(remaining[i - 1]);
      }
    });
  });
});
