/** Shared pieces of the demo boards. */

import type { KeyboardDriver } from '../types';

/** A key travelling down and back up, in mm, at time `ms`. */
export const wave = (ms: number, phase: number, depth: number) =>
  Math.max(0, Math.sin(ms / 260 + phase)) ** 2 * depth;

export const le = (v: number) => [v & 0xff, (v >> 8) & 0xff];

/** Name it as a demo, so nothing on screen claims a real keyboard is attached. */
export function markDemo(driver: KeyboardDriver): KeyboardDriver {
  const info = driver.info as { name: string };
  if (!info.name.startsWith('Demo')) info.name = `Demo · ${info.name}`;
  return driver;
}
