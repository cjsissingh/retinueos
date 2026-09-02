"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { shouldAutoDismiss, visibleToasts, TOAST_LIFETIME_MS } from "@/lib/toast-rules";

export interface Toast {
  id: number;
  message: string;
  href?: string;
  /** Needs-you toasts persist until dismissed; outcome toasts auto-dismiss
   *  at 6s. Dismissing a toast never marks its durable twin read
   *  -- that only happens by opening the centre row itself. */
  persist: boolean;
}

interface ToastContextValue {
  showToast: (message: string, opts?: { href?: string; persist?: boolean }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_CLASS_NAME =
  "pointer-events-auto flex items-center gap-3 rounded-button px-4 py-3 font-sans text-[13px] shadow-overlay no-underline";
const TOAST_STYLE = { background: "#1c1a17", color: "#f2eee6" };

export function ToastItem({ message, href, onDismiss }: { message: string; href?: string; onDismiss?: () => void }) {
  const content = (
    <>
      <i
        aria-hidden="true"
        style={{ width: 7, height: 7, borderRadius: 999, background: "var(--success)", flex: "none" }}
      />
      <span className="flex-1">{message}</span>
      {href && (
        <span className="font-mono text-xs" style={{ color: "#9c958a" }}>
          View
        </span>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="grid h-5 w-5 flex-none place-items-center rounded-full border-0 bg-transparent p-0 text-xs"
          style={{ color: "#9c958a" }}
        >
          ×
        </button>
      )}
    </>
  );

  return href ? (
    <a href={href} className={TOAST_CLASS_NAME} style={TOAST_STYLE}>
      {content}
    </a>
  ) : (
    <div className={TOAST_CLASS_NAME} style={TOAST_STYLE}>
      {content}
    </div>
  );
}

export function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss?: (id: number) => void }) {
  const { visible, overflow } = visibleToasts(toasts);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[100] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-5 md:items-end md:px-0"
      style={{ bottom: "calc(2.75rem + env(safe-area-inset-bottom, 0px) + 0.75rem)" }}
    >
      {overflow > 0 && (
        <Link
          href="/notifications"
          className="pointer-events-auto rounded-button px-4 py-2 font-sans text-xs no-underline"
          style={TOAST_STYLE}
        >
          +{overflow} more
        </Link>
      )}
      {visible.map((toast) => (
        <ToastItem
          key={toast.id}
          message={toast.message}
          href={toast.href}
          onDismiss={onDismiss ? () => onDismiss(toast.id) : undefined}
        />
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, opts?: { href?: string; persist?: boolean }) => {
      const id = nextId.current++;
      const toast: Toast = { id, message, href: opts?.href, persist: opts?.persist ?? false };
      setToasts((prev) => [...prev, toast]);
      if (shouldAutoDismiss(toast)) {
        setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
