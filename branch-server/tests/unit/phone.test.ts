import { describe, expect, it } from 'vitest';
import { phoneKey } from '@pos/shared';

describe('phoneKey (US-cust-chain: one person across branches)', () => {
  it.each([
    ['03 123 456', '9613123456'],
    ['+961 3 123456', '9613123456'],
    ['00961-3-123-456', '9613123456'],
    ['3123456', '9613123456'],
    ['71 123 456', '96171123456'],
    ['+961 71123456', '96171123456'],
    ['(0) 71-123-456', '96171123456'],
    ['+961 03 123 456', '9613123456'],
  ])('%s is the same person as the others', (raw, key) => expect(phoneKey(raw)).toBe(key));

  it('keeps another country as typed, and refuses what cannot be a phone', () => {
    expect(phoneKey('+44 7911 123456')).toBe('447911123456');
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey('123')).toBeNull();
    expect(phoneKey('abc')).toBeNull();
    expect(phoneKey('1234567890123456789')).toBeNull();
  });
});
