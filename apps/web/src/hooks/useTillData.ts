import { QueryClient, useQuery } from '@tanstack/react-query';
import { ApiError, get } from '../lib/api';
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
