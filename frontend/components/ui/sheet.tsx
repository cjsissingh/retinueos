"use client";

import { useEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import {
  FOCUSABLE_SELECTOR,
  SHEET_LAYOUT,
  isDismissKey,
  nextTrapIndex,
  sheetPanelClass,
  shouldDismissSwipe,
  type SheetAnchor,
} from "@/lib/sheet";

export type { SheetAnchor };

/**
 * The one overlay primitive -- every drawer/panel/dialog in the
 * app renders through this instead of its own bespoke markup. Mobile is
 * always a bottom sheet that slides up; `anchor` only changes the md+
 * presentation (a 460px right-hand panel, or a small anchored popover).
 *
 * Behavior: drag handle + swipe-to-dismiss, backdrop click, Esc, a focus
 * trap while open (restoring focus to what opened it), body scroll lock,
 * and `env(safe-area-inset-bottom)` padding on the mobile sheet.
 */
export function Sheet({
  open,
  onClose,
  anchor = "right",
  title,
  ariaLabel,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  /** Desktop-only variant -- mobile is always a bottom sheet. Default "right". */
  anchor?: SheetAnchor;
  title?: string;
  /** Falls back to `title` -- one of the two is required for a11y. */
  ariaLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const dragStartY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);

  // Esc to dismiss, Tab/Shift+Tab trapped to the panel's own focusable set.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (isDismissKey(e.key)) {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const current = activeElement ? focusable.indexOf(activeElement) : -1;
      e.preventDefault();
      focusable[nextTrapIndex(current, focusable.length, e.shiftKey)]?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Body scroll lock + focus enter/exit -- capture what had focus before
  // the sheet opened so closing it (any of the four dismiss paths) hands
  // focus back rather than dropping it to <body>.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panelRef.current)?.focus();
    }, 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      previouslyFocused.current?.focus();
    };
  }, [open]);

  function onTouchStart(e: ReactTouchEvent) {
    dragStartY.current = e.touches[0]?.clientY ?? null;
  }
  function onTouchMove(e: ReactTouchEvent) {
    if (dragStartY.current === null) return;
    const delta = (e.touches[0]?.clientY ?? dragStartY.current) - dragStartY.current;
    setDragY(Math.max(0, delta));
  }
  function onTouchEnd() {
    const height = panelRef.current?.getBoundingClientRect().height ?? 0;
    if (shouldDismissSwipe(dragY, height)) onClose();
    setDragY(0);
    dragStartY.current = null;
  }

  if (!open) return null;

  return (
    <div className={SHEET_LAYOUT.backdrop} style={{ background: "rgba(20, 19, 15, 0.5)" }} onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        className={`${sheetPanelClass(anchor)} border-border-strong bg-surface`}
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragY ? "none" : "transform 0.2s ease",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={SHEET_LAYOUT.dragArea}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className={SHEET_LAYOUT.handleTrack} aria-hidden="true">
            <div className={SHEET_LAYOUT.handleBar} />
          </div>
        </div>
        <div className={SHEET_LAYOUT.header}>
          {title ? <p className={SHEET_LAYOUT.title}>{title}</p> : <span />}
          <button type="button" onClick={onClose} aria-label="Close" className={SHEET_LAYOUT.close}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={SHEET_LAYOUT.body}>{children}</div>
        {footer && <div className={SHEET_LAYOUT.footer}>{footer}</div>}
      </div>
    </div>
  );
}
