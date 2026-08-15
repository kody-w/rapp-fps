import { PlayerInput } from '../../player/PlayerInput.js';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const canvas = document.getElementById('input') as HTMLCanvasElement;
Object.defineProperty(canvas, 'requestPointerLock', {
  configurable: true,
  value: async () => { throw new Error('fixture: grant refused'); },
});

const input = new PlayerInput(canvas);
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail });
};

// First click requests lock and is intentionally swallowed.
canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
await new Promise((resolve) => setTimeout(resolve, 0));
check('first-click-is-not-fire', input.fire === false, `fire=${input.fire}`);

window.dispatchEvent(new MouseEvent('mousemove', {
  bubbles: true,
  movementX: 20,
  movementY: -10,
}));
check(
  'look-survives-refused-grant',
  input.look.x !== 0 && input.look.y !== 0,
  `look=${input.look.x},${input.look.y}`,
);

// The request, not the grant, establishes play. A later click is real fire.
canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
check('subsequent-click-fires', input.fire === true, `fire=${input.fire}`);
check('fire-edge-visible', input.pressed('fire'), `pressed=${input.pressed('fire')}`);
input.endFrame();
check('edge-clears-at-frame-end', !input.pressed('fire'), `pressed=${input.pressed('fire')}`);
window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
check('mouse-up-releases-fire', input.fire === false, `fire=${input.fire}`);

window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Escape' }));
window.dispatchEvent(new MouseEvent('mousemove', {
  bubbles: true,
  movementX: 20,
  movementY: 20,
}));
check(
  'escape-disarms-seam',
  input.look.x === 0 && input.look.y === 0,
  `look=${input.look.x},${input.look.y}`,
);

input.dispose();
const result = {
  status: checks.every((item) => item.pass) ? 'passed' : 'failed',
  checks,
};
Object.assign(window as unknown as Record<string, unknown>, {
  __INPUT_RESULT__: result,
  __INPUT_READY__: true,
});
