import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'warn' | 'bad';
}

interface ToastState {
  toasts: Toast[];
  push(message: string, kind?: Toast['kind']): void;
  remove(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(message, kind = 'info') {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3000);
  },
  remove(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = (message: string, kind?: Toast['kind']): void =>
  useToasts.getState().push(message, kind);
