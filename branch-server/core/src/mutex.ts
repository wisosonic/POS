/**
 * A tiny async mutex: `run` calls never overlap, and they start in the order they were asked.
 * When nobody holds the lock, `fn` starts synchronously (before `run` returns its promise), so the lock adds no
 * delay on the common path and a test can reason about exactly when a transaction began.
 */
export class Mutex {
  private locked = false;
  private readonly waiting: (() => void)[] = [];

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.locked) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.locked = true;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // hand the lock straight to the next caller (it stays locked)
      else this.locked = false;
    }
  }
}
