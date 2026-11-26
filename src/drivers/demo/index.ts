/**
 * Demo boards: the real drivers talking to keyboards in software, so the app
 * can be tried without one. Nothing here touches USB; settings live in memory
 * for the session. Each family loads only when its demo is opened.
 */

import type { KeyboardDriver } from '../types';

export type DemoKind = 'sparklink' | 'rongyuan';

export async function connectDemo(kind: DemoKind): Promise<KeyboardDriver> {
  return kind === 'sparklink'
    ? (await import('./sparklink')).demoSparklink()
    : (await import('./rongyuan')).demoRongyuan();
}
