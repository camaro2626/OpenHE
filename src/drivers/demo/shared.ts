/** Shared pieces of the demo boards. */

import type { KeyboardDriver } from '../types';

/** A key travelling down and back up, in mm, at time `ms`. */
export const wave = (ms: number, phase: number, depth: number) =>
  Math.max(0, Math.sin(ms / 260 + phase)) ** 2 * depth;

export const le = (v: number) => [v & 0xff, (v >> 8) & 0xff];

/** Every demo is called "Demo board", so nothing on screen names a real keyboard. */
export function markDemo(driver: KeyboardDriver): KeyboardDriver {
  (driver.info as { name: string }).name = 'Demo board';
  return driver;
}
