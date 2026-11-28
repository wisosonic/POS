// A customer's identity across the chain is their phone number (docs/15 §7, decision #22). People write the same number many ways
// ("03 123 456", "+961 3 123456", "00961-3-123-456", "+961 03 123 456"), so a number is reduced to a KEY first: digits only, with Lebanon's
// country code (961) in front. Two numbers with the same key are the same person. A number too short or too long to be a phone has no key (null).

const COUNTRY = '961';

/** The digits of a phone number with the country code in front, or null when it cannot be a phone number. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^0-9]/g, '');
  if (d.startsWith('00')) d = d.slice(2); // 00961… is +961…
  if (d.startsWith(COUNTRY) && d.length >= COUNTRY.length + 7) {
    const national = d.slice(COUNTRY.length).replace(/^0/, ''); // +961 03 123 456: the 0 is the national prefix, written out of habit
    return national.length >= 7 && national.length <= 8 ? COUNTRY + national : null;
  }
  if (d.startsWith('0')) d = d.slice(1); // 03 123 456
  if (d.length >= 7 && d.length <= 8) return COUNTRY + d;
  return d.length >= 9 && d.length <= 15 && !d.startsWith('0') ? d : null; // another country's number, kept as typed
}
