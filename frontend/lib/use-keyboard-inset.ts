"use client";

import { useEffect, useState } from "react";

/**
 * How much of the layout viewport's bottom the on-screen keyboard is
 * covering, tracked via `window.visualViewport` -- `100dvh`
 * accounts for Safari's own chrome (the URL bar collapsing), but NOT a
 * software keyboard, so the chat page's fixed `dvh`-based height keeps the
 * composer pinned under the keyboard unless something explicitly shrinks
 * it by this amount. Extracted from the component so the occlusion math
 * itself can be tested without a real `window`/`visualViewport` (this
 * repo's frontend tests run under Vitest's default node environment, no
 * jsdom -- see lib/sheet.ts) -- the hook that wires it to live events stays
 * untested at that layer, same tradeoff as Sheet's own dismiss/focus math
 * vs. its DOM-touching effects.
 */

// A few px of jitter (rubber-band bounce, a rounding blip) shouldn't read
// as "the keyboard is open" -- only count a real occlusion.
const KEYBOARD_INSET_THRESHOLD_PX = 80;

/**
 * `layoutViewportHeight` is `window.innerHeight` (doesn't shrink for the
 * keyboard on iOS Safari); `visualViewportHeight`/`visualViewportOffsetTop`
 * are `window.visualViewport`'s `height`/`offsetTop` (do shrink/shift). The
 * gap between them, net of however far the page has been auto-scrolled to
 * keep the focused field visible, is the keyboard's occlusion.
 */
export function computeKeyboardInset(
  layoutViewportHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): number {
  const occluded = layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  return occluded > KEYBOARD_INSET_THRESHOLD_PX ? Math.round(occluded) : 0;
}

export interface KeyboardInset {
  /** Occluded height in px, 0 when the keyboard is closed. */
  inset: number;
  keyboardOpen: boolean;
}

export function useKeyboardInset(): KeyboardInset {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // TS doesn't carry the non-null narrowing above into this nested
    // closure, so `vv` (not the outer `viewport`) is what update() reads.
    function update(vv: VisualViewport) {
      setInset(computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop));
    }
    update(viewport);
    const onChange = () => update(viewport);
    viewport.addEventListener("resize", onChange);
    viewport.addEventListener("scroll", onChange);
    return () => {
      viewport.removeEventListener("resize", onChange);
      viewport.removeEventListener("scroll", onChange);
    };
  }, []);

  return { inset, keyboardOpen: inset > 0 };
}
