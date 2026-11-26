/**
 * Crosstalk measurement (after gk68tmr_firmware's tools/xtalk_cal.py): with
 * every other key at rest, hold one key down; how far each other key's
 * reading moves, over how far the held key's moved, is that pair's coupling.
 *
 * Readings are the board's raw values before compensation. A capture is
 * refused when another key is pressed or a coupling is implausibly large (a
 * finger brushing a neighbour), so one bad press cannot store a value that
 * would make that neighbour actuate late.
 */

import type { CrosstalkPair } from '../drivers/types';

/** Raw counts a held key must have moved. */
export const HOLD_MIN = 200;
/** Couplings below this, or below MIN_MOVE counts, are left out. */
export const MIN_K = 0.005;
export const MIN_MOVE = 4;
/** Above this a coupling is a finger on the neighbour, not magnetism. */
export const MAX_K = 0.04;
/** Other keys moving more than this share of the held key count as pressed. */
const OTHER_PRESSED = 1 / 3;

export type Capture =
  | { ok: true; pairs: CrosstalkPair[]; press: number }
  | { ok: false; reason: 'not-held' | 'other-key' | 'too-strong'; key?: number };

/** Signed movement from rest: positive the way `target` was pressed. */
export function movement(base: readonly number[], now: readonly number[], target: number) {
  const sign = now[target] - base[target] < 0 ? -1 : 1;
  return now.map((v, i) => sign * (v - base[i]));
}

/** Couplings onto every other key from holding `target` (averaged readings). */
export function capture(base: readonly number[], held: readonly number[], target: number): Capture {
  const move = movement(base, held, target);
  const press = move[target];
  if (press < HOLD_MIN) return { ok: false, reason: 'not-held' };
  const pairs: CrosstalkPair[] = [];
  for (let i = 0; i < move.length; i++) {
    if (i === target) continue;
    if (move[i] > press * OTHER_PRESSED) return { ok: false, reason: 'other-key', key: i };
    const k = move[i] / press;
    if (k > MAX_K) return { ok: false, reason: 'too-strong', key: i };
    if (move[i] >= MIN_MOVE && k >= MIN_K) pairs.push({ victim: i, aggressor: target, k });
  }
  return { ok: true, pairs, press };
}

/**
 * The table to save: the new measurements for the keys measured, the stored
 * pairs of keys not measured this time, the strongest first if it is full.
 */
export function mergeTable(
  stored: readonly CrosstalkPair[],
  measured: readonly CrosstalkPair[],
  measuredKeys: ReadonlySet<number>,
  slots: number
): CrosstalkPair[] {
  const kept = stored.filter(p => !measuredKeys.has(p.aggressor));
  const all = [...kept, ...measured];
  return all.length <= slots ? all : [...all].sort((a, b) => b.k - a.k).slice(0, slots);
}
