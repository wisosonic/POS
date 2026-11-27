import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus';
import { TopicVersions, TOPICS } from '../../src/events/versions';

// docs/14 §3: one number per topic that only goes up, raised by the events the bus publishes.
describe('topic versions (the numbers the till ping reports)', () => {
  it('start at 0 for every topic, with an epoch of their own', () => {
    const v = new TopicVersions(new EventBus());
    expect(Object.keys(v.snapshot()).sort()).toEqual([...TOPICS].sort());
    expect(Object.values(v.snapshot()).every((n) => n === 0)).toBe(true);
    expect(v.epoch).not.toBe(new TopicVersions(new EventBus()).epoch);
  });

  it('each event raises its own topic by one, whoever published it', () => {
    const bus = new EventBus();
    const v = new TopicVersions(bus);
    bus.publish('catalog.changed');
    bus.publish('catalog.changed');
    bus.publish('rate.changed');
    bus.publish('wallet.updated');
    expect(v.snapshot()).toMatchObject({ catalog: 2, rate: 1, wallets: 1, stock: 0, settings: 0, register: 0, sync: 0 });
  });

  it('a completed sale has no topic of its own', () => {
    const bus = new EventBus();
    const v = new TopicVersions(bus);
    bus.publish('sale.completed');
    expect(Object.values(v.snapshot()).every((n) => n === 0)).toBe(true);
  });

  it('is not a listening screen (the stream count stays 0), and a snapshot cannot be edited from outside', () => {
    const bus = new EventBus();
    const v = new TopicVersions(bus);
    expect(bus.size).toBe(0);
    const s = v.snapshot();
    s.catalog = 99;
    expect(v.snapshot().catalog).toBe(0);
  });
});
