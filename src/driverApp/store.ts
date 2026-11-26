/**
 * Connection state for driver-backed boards (libhmk, RongYuan). One board at
 * a time; the React tree subscribes through `useDriverConnection`.
 */

import { useSyncExternalStore } from 'react';
import { requestDriver, restoreDriver, webHid } from '../drivers/connect';
import type { KeyboardDriver } from '../drivers/types';

export type DriverConnection =
  | { state: 'idle'; error: string | null }
  | { state: 'connecting' }
  | { state: 'connected'; driver: KeyboardDriver };

let current: DriverConnection = { state: 'idle', error: null };
const listeners = new Set<() => void>();
let restoring: Promise<void> | null = null;

function set(next: DriverConnection) {
  current = next;
  for (const l of listeners) l();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const driverConnection = {
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  supported: () => webHid() !== null,

  async request(): Promise<void> {
    if (current.state === 'connecting') return;
    await restoring;
    // the quiet reconnect may have opened the board meanwhile
    if (current.state !== 'idle') return;
    set({ state: 'connecting' });
    try {
      const driver = await requestDriver();
      set(driver ? { state: 'connected', driver } : { state: 'idle', error: null });
    } catch (err) {
      set({ state: 'idle', error: message(err) });
    }
  },

  /** A board in software, to try the app without one. */
  async demo(kind: 'sparklink' | 'rongyuan'): Promise<void> {
    if (current.state === 'connecting') return;
    if (current.state === 'connected') await current.driver.close().catch(() => undefined);
    set({ state: 'connecting' });
    try {
      const { connectDemo } = await import('../drivers/demo/index');
      set({ state: 'connected', driver: await connectDemo(kind) });
    } catch (err) {
      set({ state: 'idle', error: message(err) });
    }
  },

  /** Quietly reopen a board granted in an earlier visit. */
  restore(): Promise<void> {
    if (current.state !== 'idle') return Promise.resolve();
    restoring ??= (async () => {
      try {
        const driver = await restoreDriver();
        if (driver && current.state === 'idle') set({ state: 'connected', driver });
        else await driver?.close();
      } catch {
        // stay idle; the user can connect by hand
      } finally {
        restoring = null;
      }
    })();
    return restoring;
  },

  async disconnect(error: string | null = null): Promise<void> {
    if (current.state === 'connected') await current.driver.close().catch(() => undefined);
    set({ state: 'idle', error });
  }
};

export function useDriverConnection(): DriverConnection {
  return useSyncExternalStore(driverConnection.subscribe, driverConnection.get);
}
