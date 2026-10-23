import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import type { Currency, Lookup, LookupKind, SupplierLookup, UnitLookup } from '../../lib/types';

/** One list from the API (categories, brands, units, suppliers), kept in the query cache. */
export function useLookup<T extends Lookup = Lookup>(kind: LookupKind) {
  return useQuery({ queryKey: ['lookup', kind], queryFn: () => get<{ data: T[] }>(`/${kind}`).then((r) => r.data), staleTime: 60_000 });
}
export const useUnits = () => useLookup<UnitLookup>('units');
export const useSuppliers = () => useLookup<SupplierLookup>('suppliers');

/** A price as the form shows it: dollars with cents for USD, whole lira for LBP. */
export function minorToInput(amount: number, currency: Currency): string {
  return currency === 'USD' ? (amount / 100).toFixed(2) : String(amount);
}
