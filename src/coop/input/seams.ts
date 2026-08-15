/**
 * Injectable seams between this library and the browser.
 *
 * Nothing in the runtime touches `navigator`, `window`, or a live `Gamepad`
 * directly. Instead it reads devices through a `GamepadSource` and subscribes to
 * lifecycle notifications through an `EventTargetLike`. Production wires the two
 * browser-backed implementations at the bottom of this file; a Node fixture
 * wires the deterministic doubles in `scripted.ts`. That single indirection is
 * what lets a headless test prove that two device indices never bleed into one
 * another — it can hand slot A and slot B completely independent, scripted
 * devices and watch the boundary hold, with no hardware and no DOM.
 */

import type { GamepadSnapshot } from './types.js';

/**
 * A source of gamepad snapshots, addressed by hardware index.
 *
 * `poll(index)` returns an immutable snapshot of the device at that index, or
 * `null` when no device occupies it. Implementations must return a fresh,
 * structurally-stable value each call (never the browser's live `Gamepad`,
 * which mutates in place), so a frame's input is a value that cannot change
 * under the reader mid-frame.
 */
export interface GamepadSource {
  poll(index: number): GamepadSnapshot | null;
}

/** The subset of `EventTarget` this library needs; `window` satisfies it. */
export interface EventTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The shape of a `Gamepad` as the browser exposes it, for the adapter below. */
interface BrowserGamepadLike {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number }>;
  readonly timestamp: number;
}

interface NavigatorLike {
  getGamepads(): ReadonlyArray<BrowserGamepadLike | null>;
}

/**
 * Copy the fields we depend on out of a live `Gamepad` into an immutable
 * snapshot. The browser reuses and mutates the `Gamepad` object between polls,
 * so holding a reference to it would make "this frame's input" a moving target;
 * cloning defends every downstream reader from that.
 */
export function snapshotOf(pad: BrowserGamepadLike): GamepadSnapshot {
  const axes: number[] = [];
  for (let i = 0; i < pad.axes.length; i++) axes.push(pad.axes[i]);
  const buttons: { pressed: boolean; value: number }[] = [];
  for (let i = 0; i < pad.buttons.length; i++) {
    const b = pad.buttons[i];
    buttons.push({ pressed: b.pressed, value: b.value });
  }
  return {
    index: pad.index,
    id: pad.id,
    connected: pad.connected,
    mapping: pad.mapping,
    axes,
    buttons,
    timestamp: pad.timestamp,
  };
}

/**
 * Production gamepad source backed by `navigator.getGamepads()`.
 *
 * `getGamepads()` returns a sparse array indexed by hardware slot, with `null`
 * holes for empty slots — exactly the addressing model `poll(index)` exposes.
 * A `navigator` may be injected for testing the adapter itself; by default it
 * reads the global one and throws a clear error if the Gamepad API is absent.
 */
export function browserGamepadSource(navigatorRef?: NavigatorLike): GamepadSource {
  const nav = navigatorRef ?? resolveNavigator();
  return {
    poll(index: number): GamepadSnapshot | null {
      const pads = nav.getGamepads();
      if (index < 0 || index >= pads.length) return null;
      const pad = pads[index];
      if (!pad) return null;
      return snapshotOf(pad);
    },
  };
}

/** Adapt a real `window` (or any global event target) to `EventTargetLike`. */
export function browserEventTarget(target?: EventTargetLike): EventTargetLike {
  const resolved = target ?? resolveWindow();
  return {
    addEventListener: (type, listener) => resolved.addEventListener(type, listener),
    removeEventListener: (type, listener) => resolved.removeEventListener(type, listener),
  };
}

function resolveNavigator(): NavigatorLike {
  const candidate = (globalThis as { navigator?: Partial<NavigatorLike> }).navigator;
  if (!candidate || typeof candidate.getGamepads !== 'function') {
    throw new Error(
      'browserGamepadSource: navigator.getGamepads is unavailable; the Gamepad API '
        + 'requires a browser context (inject a GamepadSource for headless use)',
    );
  }
  return candidate as NavigatorLike;
}

function resolveWindow(): EventTargetLike {
  const candidate = (globalThis as { window?: Partial<EventTargetLike> }).window;
  if (
    !candidate
    || typeof candidate.addEventListener !== 'function'
    || typeof candidate.removeEventListener !== 'function'
  ) {
    throw new Error(
      'browserEventTarget: window is unavailable; inject an EventTargetLike for '
        + 'headless use',
    );
  }
  return candidate as EventTargetLike;
}
