/**
 * Browser input provider for the player. Owns pointer lock, mouse-look
 * accumulation (already scaled to radians), and the WASD / jump / crouch /
 * sprint / fire / aim / reload bindings, and presents them through the engine's
 * `InputState` contract so the motor never touches the DOM.
 *
 * The core motor is pure and testable precisely because this lives apart from
 * it: a harness can feed synthetic `InputState`, and production wires this.
 */

import type { InputState } from '../core/contracts.js';
import { DEFAULT_PLAYER_TUNING } from './config.js';

type Action = 'jump' | 'crouch' | 'sprint' | 'fire' | 'aim' | 'reload';

const KEY_ACTIONS: Readonly<Record<string, Action>> = {
  Space: 'jump',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  KeyC: 'crouch',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyR: 'reload',
};

export class PlayerInput implements InputState {
  readonly move = { x: 0, y: 0 };
  readonly look = { x: 0, y: 0 };

  jump = false;
  crouch = false;
  sprint = false;
  fire = false;
  aim = false;
  reload = false;

  private readonly heldCodes = new Set<string>();
  private readonly edgeActions = new Set<string>();
  private disposed = false;

  constructor(
    private readonly element: HTMLElement,
    public sensitivityRadPerPixel = DEFAULT_PLAYER_TUNING.lookSensitivityRadPerPixel,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    window.addEventListener('mouseup', this.onMouseUp);
    this.element.addEventListener('mousedown', this.onMouseDown);
    this.element.addEventListener('contextmenu', this.onContextMenu);
  }

  pressed = (action: string): boolean => this.edgeActions.has(action);

  consumePressed(action: string): boolean {
    const hadAction = this.edgeActions.has(action);
    this.edgeActions.delete(action);
    return hadAction;
  }

  consumeLook(): { x: number; y: number } {
    const result = { x: this.look.x, y: this.look.y };
    this.look.x = 0;
    this.look.y = 0;
    return result;
  }

  clearLook(): void {
    this.look.x = 0;
    this.look.y = 0;
  }

  async requestPointerLock(): Promise<void> {
    if (document.pointerLockElement === this.element) return;

    const request = this.element.requestPointerLock.bind(this.element) as (
      options?: { unadjustedMovement?: boolean },
    ) => Promise<void> | void;

    try {
      await request({ unadjustedMovement: true });
    } catch {
      try {
        await request();
      } catch {
        // Pointer lock can be denied by browser policy; input remains usable.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.element.removeEventListener('mousedown', this.onMouseDown);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.reset();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.heldCodes.has(event.code)) {
      const action = KEY_ACTIONS[event.code];
      if (action) this.edgeActions.add(action);
    }
    this.heldCodes.add(event.code);
    this.refreshKeyboardState();

    if (document.pointerLockElement === this.element
      && (event.code === 'Space' || event.code.startsWith('Arrow'))) {
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.heldCodes.delete(event.code);
    this.refreshKeyboardState();
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.element) return;
    this.look.x += event.movementX * this.sensitivityRadPerPixel;
    this.look.y += event.movementY * this.sensitivityRadPerPixel;
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.element) {
      void this.requestPointerLock();
      return;
    }

    if (event.button === 0) {
      if (!this.fire) this.edgeActions.add('fire');
      this.fire = true;
    } else if (event.button === 2) {
      if (!this.aim) this.edgeActions.add('aim');
      this.aim = true;
    }
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.fire = false;
    if (event.button === 2) this.aim = false;
  };

  private onContextMenu = (event: Event): void => event.preventDefault();

  private onBlur = (): void => this.reset();

  private refreshKeyboardState(): void {
    const x = Number(this.heldCodes.has('KeyD')) - Number(this.heldCodes.has('KeyA'));
    const y = Number(this.heldCodes.has('KeyW')) - Number(this.heldCodes.has('KeyS'));
    const length = Math.hypot(x, y);
    this.move.x = length > 1 ? x / length : x;
    this.move.y = length > 1 ? y / length : y;

    this.jump = this.heldCodes.has('Space');
    this.crouch = this.heldCodes.has('ControlLeft')
      || this.heldCodes.has('ControlRight')
      || this.heldCodes.has('KeyC');
    this.sprint = this.heldCodes.has('ShiftLeft') || this.heldCodes.has('ShiftRight');
    this.reload = this.heldCodes.has('KeyR');
  }

  private reset(): void {
    this.heldCodes.clear();
    this.edgeActions.clear();
    this.move.x = 0;
    this.move.y = 0;
    this.look.x = 0;
    this.look.y = 0;
    this.jump = false;
    this.crouch = false;
    this.sprint = false;
    this.fire = false;
    this.aim = false;
    this.reload = false;
  }
}
