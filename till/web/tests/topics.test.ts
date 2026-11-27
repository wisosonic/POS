import { describe, it, expect } from 'vitest';
import { changedTopics, TOPICS, watchTopics, type PingAnswer } from '../src/lib/topics';

// Live updates from the ping (docs/14 §3): which topics moved, and the loop that asks.
const at = (epoch: string, versions: PingAnswer['versions']): PingAnswer => ({ epoch, versions });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('which topics to refresh', () => {
  it('the first answer is nothing new: the screen has just loaded everything', () => {
    expect(changedTopics(null, at('e1', { catalog: 5 }))).toEqual([]);
  });

  it('only the topics whose number moved', () => {
    const before = at('e1', { catalog: 1, stock: 4, rate: 0 });
    expect(changedTopics(before, at('e1', { catalog: 1, stock: 5, rate: 0 }))).toEqual(['stock']);
    expect(changedTopics(before, at('e1', { catalog: 2, stock: 4, rate: 1 }))).toEqual(['catalog', 'rate']);
    expect(changedTopics(before, at('e1', { catalog: 1, stock: 4, rate: 0 }))).toEqual([]);
  });

  it('a new epoch (a restart or a restore) refreshes everything, even if the numbers went down', () => {
    expect(changedTopics(at('e1', { stock: 9 }), at('e2', { stock: 0 }))).toEqual([...TOPICS]);
  });

  it('an answer after a missed one refreshes everything', () => {
    expect(changedTopics(at('e1', { stock: 1 }), at('e1', { stock: 1 }), true)).toEqual([...TOPICS]);
  });
});

describe('asking every few seconds', () => {
  it('reports a change once, and not again while nothing moves', async () => {
    const answers = [at('e', { catalog: 1 }), at('e', { catalog: 1 }), at('e', { catalog: 2 }), at('e', { catalog: 2 })];
    const heard: string[][] = [];
    const stop = watchTopics({ ask: async () => answers.shift() ?? at('e', { catalog: 2 }), onChange: (t) => heard.push(t), everyMs: 5 });
    await wait(80);
    stop();
    expect(heard).toEqual([['catalog']]);
  });

  it('an outage then an answer refreshes everything, once', async () => {
    const steps: (PingAnswer | null)[] = [at('e', { stock: 1 }), null, null, at('e', { stock: 1 })];
    const heard: string[][] = [];
    const stop = watchTopics({
      ask: async () => (steps.length ? steps.shift()! : at('e', { stock: 1 })),
      onChange: (t) => heard.push(t),
      everyMs: 5,
    });
    await wait(100);
    stop();
    expect(heard).toEqual([[...TOPICS]]);
  });

  it('a question that throws is an outage, not a crash, and the loop goes on', async () => {
    let n = 0;
    const heard: string[][] = [];
    const stop = watchTopics({
      ask: async () => {
        n++;
        if (n === 2) throw new Error('boom');
        return at('e', { rate: 1 });
      },
      onChange: (t) => heard.push(t),
      everyMs: 5,
    });
    await wait(100);
    stop();
    expect(n).toBeGreaterThan(3);
    expect(heard).toEqual([[...TOPICS]]);
  });

  it('stops asking when stopped', async () => {
    let n = 0;
    const stop = watchTopics({
      ask: async () => {
        n++;
        return null;
      },
      onChange: () => undefined,
      everyMs: 5,
    });
    await wait(40);
    stop();
    const seen = n;
    await wait(60);
    expect(n).toBe(seen);
  });
});
