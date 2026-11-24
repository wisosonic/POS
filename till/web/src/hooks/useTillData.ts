import { QueryClient, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { ApiError, get } from '../lib/api';
import { getTerminalToken, subscribeTerminal } from '../lib/terminal';
import type { HoldSummary, LowStockItem, PublicSettings, RegisterSession } from '../lib/types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // A refusal (4xx) will not change by asking again. A dropped connection might.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

export const useSettings = () =>
  useQuery({ queryKey: ['settings'], queryFn: () => get<PublicSettings>('/settings/public'), staleTime: 5 * 60_000 });

export const useRate = () =>
  useQuery({
    queryKey: ['rate'],
    queryFn: () => get<{ rateLbpPerUsd: number }>('/exchange-rates/current').then((r) => r.rateLbpPerUsd),
    staleTime: 5 * 60_000,
  });

/** The open register, or null when there is none (the till then asks for the opening balances). */
export const useRegister = () =>
  useQuery({
    queryKey: ['register'],
    queryFn: async () => {
      try {
        return await get<RegisterSession>('/registers/current');
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NO_OPEN_REGISTER') return null;
        throw e;
      }
    },
  });

export const useHolds = () =>
  useQuery({ queryKey: ['holds'], queryFn: () => get<{ data: HoldSummary[] }>('/holds').then((r) => r.data), staleTime: 10_000 });

export const useAlerts = () =>
  useQuery({ queryKey: ['alerts'], queryFn: () => get<{ data: LowStockItem[] }>('/stock/alerts').then((r) => r.data) });

export const money = (n: number | undefined) => n ?? 0;

/** Which till this device is (docs/11-multi-branch.md §3.4). An error with code TERMINAL_REQUIRED means it is not set up as a till yet. */
export type TerminalMe = {
  id: number;
  code: string;
  name: string;
  branchId: number;
  warehouseId: number | null;
  /** `server`: the server prints on its own printer. `agent`: receipts are queued for the print agent on this PC. */
  printMode: 'server' | 'agent';
  openSessionId: number | null;
};

export const useDeviceToken = () => useSyncExternalStore(subscribeTerminal, () => getTerminalToken());

export function useTerminal() {
  const token = useDeviceToken();
  // The device token is part of the key, so enrolling (or the server forgetting this till) asks again at once.
  return useQuery({
    queryKey: ['terminal', token ?? null],
    queryFn: () => get<TerminalMe>('/terminals/me'),
    staleTime: 60_000,
    retry: false,
  });
}

/** True when the server says this device is not a till (no usable token and more than one till exists). */
export const isNotATill = (error: unknown) =>
  error instanceof ApiError && (error.code === 'TERMINAL_REQUIRED' || error.code === 'TERMINAL_UNKNOWN');

/** Can this till print a receipt on a receipt printer? Either the server has one (a one-till shop) or this till has a print agent. */
export function usePrinterAvailable(): boolean {
  const settings = useSettings().data;
  const terminal = useTerminal().data;
  return settings?.printerConfigured === true || terminal?.printMode === 'agent';
}
