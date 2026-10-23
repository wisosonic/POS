import { create } from 'zustand';

export type Toast = { id: number; kind: 'info' | 'success' | 'warning' | 'error'; text: string };

type ToastState = { toasts: Toast[]; push: (kind: Toast['kind'], text: string, ms?: number) => void; dismiss: (id: number) => void };

let next = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(kind, text, ms = kind === 'error' ? 6000 : 3500) {
    const id = ++next;
    // The same message twice in a row replaces the first instead of stacking up (a held-down scanner trigger).
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, kind, text }].slice(-4) }));
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (text: string, ms?: number) => useToasts.getState().push('info', text, ms),
  success: (text: string, ms?: number) => useToasts.getState().push('success', text, ms),
  warning: (text: string, ms?: number) => useToasts.getState().push('warning', text, ms),
  error: (text: string, ms?: number) => useToasts.getState().push('error', text, ms),
};
