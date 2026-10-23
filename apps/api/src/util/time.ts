export const SHOP_TIME_ZONE = 'Asia/Beirut';

/** Offset of `timeZone` from UTC at the given instant, in milliseconds (positive east of UTC). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the shop's current local day began ("today" for reports). */
export function shopDayStart(now: Date = new Date(), timeZone: string = SHOP_TIME_ZONE): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  const localMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The offset at midnight can differ from the offset now on a daylight-saving change day, so refine once.
  const first = new Date(localMidnightAsUtc - zoneOffsetMs(now, timeZone));
  return new Date(localMidnightAsUtc - zoneOffsetMs(first, timeZone));
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TIME_ZONE, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });

/** The shop-local calendar day (YYYY-MM-DD) of an instant. */
export const localDay = (iso: string | Date) => dayFormat.format(new Date(iso));

const clockParts = (instant: string | Date) => {
  const parts = clockFormat.formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: n('hour'), minute: n('minute') };
};
/** The shop-local hour (0-23) of an instant. */
export const localHour = (iso: string | Date) => clockParts(iso).hour;
/** Minutes since shop-local midnight (0-1439). */
export const localMinutes = (iso: string | Date) => {
  const { hour, minute } = clockParts(iso);
  return hour * 60 + minute;
};

export const nowIso = () => new Date().toISOString();
