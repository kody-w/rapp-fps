/**
 * On-screen touch controls for phones and tablets.
 *
 * These feed the SAME `InputState` the keyboard/mouse provider writes to — a
 * bottom-left virtual joystick drives `move`, a bottom-right button holds
 * `fire`, and a drag anywhere else accumulates the per-frame `look` delta that
 * pointer-lock supplies on desktop. Nothing here reads engine internals; it
 * only mutates the shared input contract, so the player controller consumes
 * touch and desktop input through one path.
 *
 * Implemented on the raw Touch Events API (`touchstart`/`touchmove`/`touchend`/
 * `touchcancel`) rather than Pointer Events. Pointer Events work on modern iOS,
 * but Touch Events are the substrate every mobile Safari has shipped reliably —
 * `changedTouches` + `Touch.identifier` give unambiguous multi-touch, and a
 * non-passive `preventDefault()` on the surface is what actually suppresses
 * Safari's scroll / rubber-band / double-tap-zoom. Each finger is tracked by its
 * `identifier`, so the joystick, look-drag and fire button all work at once.
 *
 * The overlay is mounted only on coarse-pointer devices; desktop never sees it.
 * `look` is an accumulated per-frame delta by contract — this module adds into
 * it and relies on the player system draining it once per frame (PlayerSystem
 * calls `consumeLook()`), exactly as it drains mouse deltas.
 */

import type { InputState } from '../core/contracts.js';

/** True on phones/tablets, false on a desktop with a mouse. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia?.bind(window);
  const coarseNoHover = mm?.('(hover: none) and (pointer: coarse)').matches ?? false;
  const hasTouch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const hasHover = mm?.('(hover: hover)').matches ?? false;
  return coarseNoHover || (hasTouch && !hasHover);
}

/** Radius the thumb travels before `move` saturates at 1, in CSS pixels. */
const JOYSTICK_RADIUS = 56;
/** Look sensitivity: screen pixels dragged → radians, per axis. */
const LOOK_SENSITIVITY = 0.005;
/** Class on <html> while the overlay is mounted; hides the desktop reticle. */
const TOUCH_CLASS = 'tc-touch';

const STYLE_ID = 'touch-controls-style';
const R = JOYSTICK_RADIUS;
const CSS = `
.tc-root{position:fixed;inset:0;z-index:40;touch-action:none;-webkit-user-select:none;user-select:none;pointer-events:auto;-webkit-tap-highlight-color:transparent}
.tc-root *{box-sizing:border-box;pointer-events:none}
.tc-base{position:absolute;left:36px;bottom:36px;width:${R * 2}px;height:${R * 2}px;border-radius:50%;border:2px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);opacity:.4;transition:opacity .12s ease}
.tc-base.tc-on{opacity:1;border-color:rgba(255,255,255,.32)}
.tc-thumb{position:absolute;left:50%;top:50%;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;background:rgba(255,255,255,.2);border:2px solid rgba(255,255,255,.42);will-change:transform}
.tc-fire{position:absolute;right:34px;bottom:48px;width:96px;height:96px;border-radius:50%;border:2px solid rgba(255,80,80,.5);background:rgba(255,60,60,.16);color:rgba(255,255,255,.8);display:flex;align-items:center;justify-content:center;font:600 14px/1 system-ui,-apple-system,sans-serif;letter-spacing:.09em}
.tc-fire.tc-on{background:rgba(255,60,60,.44);transform:scale(.94)}
html.${TOUCH_CLASS} .combat-hud .hud-reticle{display:none!important}
`;

/** What a live finger is currently driving. */
type Role = 'move' | 'look' | 'fire';

export class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly fire: HTMLDivElement;

  /** identifier → role, for every finger the overlay currently owns. */
  private readonly touches = new Map<number, Role>();
  /** Origin the active joystick finger is measured from (its landing point). */
  private moveOrigin = { x: 0, y: 0 };
  /** Last position of the look finger, for delta accumulation. */
  private lookLast = { x: 0, y: 0 };
  private disposed = false;

  constructor(private readonly input: InputState) {
    ensureStyle();
    document.documentElement.classList.add(TOUCH_CLASS);

    this.root = el('div', 'tc-root');
    this.base = el('div', 'tc-base');
    this.thumb = el('div', 'tc-thumb');
    this.fire = el('div', 'tc-fire');
    this.fire.textContent = 'FIRE';
    this.base.appendChild(this.thumb);
    this.root.append(this.base, this.fire);
    document.body.appendChild(this.root);

    // Non-passive so preventDefault actually cancels Safari scroll/zoom/gestures.
    const opts: AddEventListenerOptions = { passive: false };
    this.root.addEventListener('touchstart', this.onTouchStart, opts);
    this.root.addEventListener('touchmove', this.onTouchMove, opts);
    this.root.addEventListener('touchend', this.onTouchEnd, opts);
    this.root.addEventListener('touchcancel', this.onTouchEnd, opts);
    // Pinch-zoom on iOS arrives as gesture* events, independent of touchmove.
    window.addEventListener('gesturestart', preventDefault, opts);
    window.addEventListener('gesturechange', preventDefault, opts);
  }

  // ── Touch routing ────────────────────────────────────────────────────────
  private onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.touches.has(t.identifier)) continue;
      const role = this.classify(t.clientX, t.clientY);
      this.touches.set(t.identifier, role);
      if (role === 'move') this.beginMove(t.clientX, t.clientY);
      else if (role === 'look') this.lookLast = { x: t.clientX, y: t.clientY };
      else this.setFire(true);
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const role = this.touches.get(t.identifier);
      if (role === 'move') this.applyMove(t.clientX, t.clientY);
      else if (role === 'look') this.applyLook(t.clientX, t.clientY);
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const role = this.touches.get(t.identifier);
      if (role === undefined) continue;
      this.touches.delete(t.identifier);
      if (role === 'move') this.endMove();
      else if (role === 'fire') this.setFire(false);
    }
  };

  /**
   * A landing finger is claimed by the fire button if it lands on it, else by
   * the joystick if it lands in the bottom-left quadrant, else it drives look.
   * "Anywhere else" — the whole surface outside the two widgets — looks.
   */
  private classify(x: number, y: number): Role {
    if (hits(this.fire, x, y)) return 'fire';
    const inLeft = x < innerWidth * 0.5;
    const inBottom = y > innerHeight * 0.42;
    // Only claim for the joystick if no finger is already driving it, so a
    // second thumb in the corner falls through to look instead of stealing move.
    const moveFree = !this.hasRole('move');
    if (inLeft && inBottom && moveFree) return 'move';
    return 'look';
  }

  private hasRole(role: Role): boolean {
    for (const r of this.touches.values()) if (r === role) return true;
    return false;
  }

  // ── Movement: joystick floats to where the thumb lands ───────────────────
  private beginMove(x: number, y: number): void {
    this.moveOrigin = { x, y };
    this.base.style.left = `${x - R}px`;
    this.base.style.top = `${y - R}px`;
    this.base.style.bottom = 'auto';
    this.base.classList.add('tc-on');
    this.applyMove(x, y);
  }

  private applyMove(x: number, y: number): void {
    let dx = x - this.moveOrigin.x;
    let dy = y - this.moveOrigin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > R) {
      const s = R / dist;
      dx *= s;
      dy *= s;
    }
    this.thumb.style.transform = `translate(${dx}px,${dy}px)`;
    this.input.move.x = dx / R;
    // Screen-up is forward, so negate Y to get +1 forward on `move.y`.
    this.input.move.y = -dy / R;
  }

  private endMove(): void {
    this.input.move.x = 0;
    this.input.move.y = 0;
    this.thumb.style.transform = 'translate(0,0)';
    this.base.classList.remove('tc-on');
    // Return the base to its resting home in the bottom-left corner.
    this.base.style.left = '36px';
    this.base.style.top = 'auto';
    this.base.style.bottom = '36px';
  }

  // ── Look: drag accumulates a per-frame delta the player system drains ────
  private applyLook(x: number, y: number): void {
    this.input.look.x += (x - this.lookLast.x) * LOOK_SENSITIVITY;
    this.input.look.y += (y - this.lookLast.y) * LOOK_SENSITIVITY;
    this.lookLast = { x, y };
  }

  // ── Fire: hold to shoot ──────────────────────────────────────────────────
  private setFire(on: boolean): void {
    this.input.fire = on;
    this.fire.classList.toggle('tc-on', on);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const opts: AddEventListenerOptions = { passive: false };
    this.root.removeEventListener('touchstart', this.onTouchStart, opts);
    this.root.removeEventListener('touchmove', this.onTouchMove, opts);
    this.root.removeEventListener('touchend', this.onTouchEnd, opts);
    this.root.removeEventListener('touchcancel', this.onTouchEnd, opts);
    window.removeEventListener('gesturestart', preventDefault, opts);
    window.removeEventListener('gesturechange', preventDefault, opts);
    this.touches.clear();
    this.input.move.x = 0;
    this.input.move.y = 0;
    this.input.fire = false;
    this.root.remove();
    document.documentElement.classList.remove(TOUCH_CLASS);
  }
}

/** Mount the overlay only on touch devices; returns null (and no-ops) on desktop. */
export function mountTouchControls(input: InputState): TouchControls | null {
  if (!isTouchDevice()) return null;
  return new TouchControls(input);
}

function el(tag: string, className: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  node.className = className;
  return node;
}

/** Does the point fall inside the element's current on-screen box? */
function hits(node: HTMLElement, x: number, y: number): boolean {
  const r = node.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function preventDefault(e: Event): void {
  e.preventDefault();
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
