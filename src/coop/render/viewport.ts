/**
 * Horizontal split-screen viewport/scissor math. — Refs #71
 *
 * This module is the single source of truth for *where on the drawing buffer*
 * each co-op player's image goes. It is pure arithmetic on plain numbers: no
 * THREE, no renderer, no DOM. Everything downstream — the coordinator that sets
 * the real GL state, the browser-free fixtures, and the WebGL harness — asks
 * this module and never re-derives the rectangles itself. The failure mode that
 * costs the most in split-screen is two places computing the seam and
 * disagreeing by a pixel; defining it once here removes that failure.
 *
 * ── Two coordinate systems, kept distinct on purpose ─────────────────────────
 *
 *  - CSS / logical pixels: what layout and `window.innerWidth/Height` speak, and
 *    what `THREE.WebGLRenderer.setViewport/setScissor` accept. THREE multiplies
 *    these by the pixel ratio internally.
 *  - Backing / drawing-buffer pixels: the real framebuffer the GPU rasterises
 *    into, `floor(css * pixelRatio)` per axis (exactly how `renderer.setSize`
 *    sizes the canvas in r185). WebGL `viewport`/`scissor` are integers in this
 *    space with the origin at the BOTTOM-LEFT.
 *
 * The backing rectangles are the source of truth because only integers can tile
 * a buffer with no gap and no overlap. The CSS rectangles are derived as
 * `backing / pixelRatio` so that when THREE re-applies `round(css * pixelRatio)`
 * (its r185 conversion for `setViewport`/`setScissor`) it lands back on the
 * exact integer backing rectangle — `round(B / pr * pr) === B` for an integer B,
 * robust to floating-point error because the value sits a whole unit from any
 * half-integer. `checkExactTiling` asserts precisely this round-trip.
 *
 * ── Orientation ──────────────────────────────────────────────────────────────
 *
 * "Horizontal split" means the *divider is horizontal*: the players are stacked
 * one above the other. Player 1 gets the TOP slot, player 2 the BOTTOM slot,
 * each the full backing width and about half the backing height. (A vertical
 * divider — side-by-side halves — is a different layout this module does not
 * claim to implement.) When the backing height is odd the two integer halves
 * cannot be equal; the extra row goes to the slot named by `oddRowSlot`
 * (default the top) so the union still tiles the buffer exactly. This is a
 * deterministic, documented choice, not an accident of rounding.
 */

/** How many local players share the drawing buffer. */
export type CoopPlayerCount = 1 | 2;

/** Which region of the screen a slot occupies. */
export type CoopSlotRole = 'full' | 'top' | 'bottom';

/** An axis-aligned rectangle. Backing rects are integers; CSS rects are reals. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One player's place on the drawing buffer. */
export interface CoopSlot {
  /** 0-based slot index in player order (P1 first). */
  readonly index: number;
  readonly role: CoopSlotRole;
  /** Integer, bottom-left-origin rectangle in drawing-buffer pixels. Authoritative. */
  readonly backing: PixelRect;
  /** `backing / pixelRatio`; the logical-pixel rect to hand THREE's setViewport/setScissor. */
  readonly css: PixelRect;
  /** `backing.width / backing.height` — the true rendered pixel aspect for this slot's camera. */
  readonly aspect: number;
}

export interface CoopViewportInput {
  /** Logical width, e.g. `window.innerWidth` or `renderer.getSize().x`. */
  readonly cssWidth: number;
  /** Logical height, e.g. `window.innerHeight` or `renderer.getSize().y`. */
  readonly cssHeight: number;
  /** Effective device pixel ratio the renderer was configured with (e.g. `renderer.getPixelRatio()`). */
  readonly pixelRatio: number;
  readonly players: CoopPlayerCount;
  /**
   * Which slot receives the extra backing row when the backing height is odd
   * (2-player only). Defaults to the top slot. Ignored for 1 player.
   */
  readonly oddRowSlot?: 'top' | 'bottom';
}

export interface RenderableCoopPlan {
  readonly renderable: true;
  readonly players: CoopPlayerCount;
  readonly pixelRatio: number;
  /** Whole drawing-buffer size the slots tile, in backing pixels. */
  readonly backing: { readonly width: number; readonly height: number };
  /** Logical size the plan was computed from. */
  readonly css: { readonly width: number; readonly height: number };
  /** Player-ordered slots (P1 first). Length equals `players`. */
  readonly slots: readonly CoopSlot[];
}

export interface RefusedCoopPlan {
  readonly renderable: false;
  /** Human-readable reason the size was refused; safe to log, never a silent no-op. */
  readonly reason: string;
}

/**
 * The result of planning. A discriminated union rather than a thrown error so a
 * caller can refuse to touch GL state for a zero/degenerate size without a
 * try/catch, and so the refusal is a first-class value the fixtures assert on.
 */
export type CoopViewportPlan = RenderableCoopPlan | RefusedCoopPlan;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function backingToCss(rect: PixelRect, pixelRatio: number): PixelRect {
  return {
    x: rect.x / pixelRatio,
    y: rect.y / pixelRatio,
    width: rect.width / pixelRatio,
    height: rect.height / pixelRatio,
  };
}

function makeSlot(
  index: number,
  role: CoopSlotRole,
  backing: PixelRect,
  pixelRatio: number,
): CoopSlot {
  return {
    index,
    role,
    backing,
    css: backingToCss(backing, pixelRatio),
    aspect: backing.width / backing.height,
  };
}

/**
 * Compute the viewport/scissor plan for 1-player full-screen or 2-player
 * horizontal split. Pure and total: every invalid or degenerate input returns a
 * `renderable: false` refusal instead of throwing or producing a NaN aspect.
 */
export function planCoopViewports(input: CoopViewportInput): CoopViewportPlan {
  const { cssWidth, cssHeight, pixelRatio, players } = input;

  if (!isPositiveFinite(cssWidth) || !isPositiveFinite(cssHeight)) {
    return {
      renderable: false,
      reason: `non-positive or non-finite logical size ${cssWidth}x${cssHeight}`,
    };
  }
  if (!isPositiveFinite(pixelRatio)) {
    return { renderable: false, reason: `non-positive or non-finite pixelRatio ${pixelRatio}` };
  }
  if (players !== 1 && players !== 2) {
    return { renderable: false, reason: `unsupported player count ${players}` };
  }

  // Match renderer.setSize exactly: the drawing buffer is floor(css * pr).
  const backingWidth = Math.floor(cssWidth * pixelRatio);
  const backingHeight = Math.floor(cssHeight * pixelRatio);

  if (backingWidth < 1 || backingHeight < 1) {
    return {
      renderable: false,
      reason: `drawing buffer collapses to ${backingWidth}x${backingHeight} backing px`,
    };
  }

  const common = {
    pixelRatio,
    backing: { width: backingWidth, height: backingHeight },
    css: { width: cssWidth, height: cssHeight },
  } as const;

  if (players === 1) {
    const slot = makeSlot(
      0,
      'full',
      { x: 0, y: 0, width: backingWidth, height: backingHeight },
      pixelRatio,
    );
    return { renderable: true, players: 1, ...common, slots: [slot] };
  }

  // Two players, horizontal divider. Split the backing HEIGHT into two adjacent
  // integer bands that tile [0, backingHeight) exactly.
  if (backingHeight < 2) {
    return {
      renderable: false,
      reason: `backing height ${backingHeight} px cannot host two horizontal slots`,
    };
  }

  const half = Math.floor(backingHeight / 2);
  const topGetsExtra = (input.oddRowSlot ?? 'top') === 'top';
  const bottomHeight = topGetsExtra ? half : backingHeight - half;
  const topHeight = backingHeight - bottomHeight;
  // splitY is the shared edge: the bottom band is [0, splitY), the top band is
  // [splitY, backingHeight). One value, so the two bands cannot disagree.
  const splitY = bottomHeight;

  // Player 1 → TOP (screen top == larger y in bottom-left GL coords).
  const topSlot = makeSlot(
    0,
    'top',
    { x: 0, y: splitY, width: backingWidth, height: topHeight },
    pixelRatio,
  );
  // Player 2 → BOTTOM.
  const bottomSlot = makeSlot(
    1,
    'bottom',
    { x: 0, y: 0, width: backingWidth, height: bottomHeight },
    pixelRatio,
  );

  return { renderable: true, players: 2, ...common, slots: [topSlot, bottomSlot] };
}

export interface TilingReport {
  readonly exact: boolean;
  /** Present when `exact` is false: the first defect found. */
  readonly reason?: string;
}

/**
 * Prove a plan's slots tile the whole drawing buffer with no gap and no overlap,
 * and that every rectangle survives THREE's `round(css * pixelRatio)`
 * re-application without moving a pixel. This is the seam-gap/overlap oracle the
 * fixtures and the WebGL harness both call; a naive CSS-space split that leaves
 * a one-pixel seam on an odd buffer fails here.
 */
export function checkExactTiling(plan: CoopViewportPlan): TilingReport {
  if (!plan.renderable) return { exact: false, reason: `plan refused: ${plan.reason}` };

  const { backing, pixelRatio, slots } = plan;

  for (const slot of slots) {
    const b = slot.backing;
    for (const [name, value] of [
      ['x', b.x], ['y', b.y], ['width', b.width], ['height', b.height],
    ] as const) {
      if (!Number.isInteger(value)) {
        return { exact: false, reason: `slot ${slot.index} backing ${name} ${value} is not an integer` };
      }
    }
    if (b.width < 1 || b.height < 1) {
      return { exact: false, reason: `slot ${slot.index} has empty backing extent ${b.width}x${b.height}` };
    }
    if (b.x !== 0 || b.width !== backing.width) {
      return {
        exact: false,
        reason: `slot ${slot.index} does not span the full backing width (x=${b.x}, w=${b.width})`,
      };
    }
    // THREE re-applies round(css * pixelRatio); confirm it reproduces the exact
    // integer backing rect, so the coordinator's setViewport/setScissor cannot
    // introduce a seam the math avoided.
    const roundTrip: Array<[string, number, number]> = [
      ['x', Math.round(slot.css.x * pixelRatio), b.x],
      ['y', Math.round(slot.css.y * pixelRatio), b.y],
      ['width', Math.round(slot.css.width * pixelRatio), b.width],
      ['height', Math.round(slot.css.height * pixelRatio), b.height],
    ];
    for (const [name, applied, expected] of roundTrip) {
      if (applied !== expected) {
        return {
          exact: false,
          reason: `slot ${slot.index} ${name} round-trips to ${applied}, expected ${expected}`,
        };
      }
    }
  }

  // Rows: order the bands bottom-to-top and require exact adjacency and full
  // coverage of [0, backing.height).
  const bands = [...slots].sort((a, b) => a.backing.y - b.backing.y);
  let cursor = 0;
  for (const slot of bands) {
    if (slot.backing.y !== cursor) {
      return {
        exact: false,
        reason: `row gap/overlap at y=${cursor}: slot ${slot.index} starts at y=${slot.backing.y}`,
      };
    }
    cursor += slot.backing.height;
  }
  if (cursor !== backing.height) {
    return {
      exact: false,
      reason: `rows cover ${cursor} of ${backing.height} backing px`,
    };
  }

  return { exact: true };
}
