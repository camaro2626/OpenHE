/**
 * RongYuan demo: a 68-key "Demo board" (the picture and keymap of registry
 * entry 2268, a gen2 board), answering sharkfin's gen2 commands in memory,
 * with the cable travel stream on WASD and space.
 */

import { bundledDeps } from '../rongyuan/connect';
import { RongyuanDriver } from '../rongyuan/driver';
import { Wire, type Clock } from '../rongyuan/wire';
import type { HidDeviceLike } from '../transport';
import type { KeyboardDriver } from '../types';
import { markDemo, wave } from './shared';

/** Time passes only when the driver waits, so flash pacing costs nothing. */
function virtualClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => {
      t += ms;
      await Promise.resolve();
    }
  };
}

const RY_DEMO_ID = 2268;

/** sharkfin's gen2 command set, enough for every page; checksums are not checked. */
function rongyuanBoard(layoutSlots: Array<{ slot: number; entry: number[] }>) {
  const PROFILES = 3;
  const wide = new Set([0, 1, 2, 3, 4, 6]);
  const blank = () => new Uint8Array(512);
  const keymaps = Array.from({ length: PROFILES }, () => [blank(), blank(), blank(), blank()]);
  const fn = Array.from({ length: PROFILES }, blank);
  for (const { slot, entry } of layoutSlots) for (const km of keymaps) km[0].set(entry, slot * 4);
  const defaults: Record<number, number> = {
    0: 200,
    1: 280,
    2: 50,
    3: 50,
    4: 50,
    5: 0,
    6: 30,
    7: 0,
    9: 255,
    252: 0
  };
  const columns = Array.from({ length: PROFILES }, () => {
    const m = new Map<number, number[]>();
    for (const [c, v] of Object.entries(defaults)) m.set(Number(c), new Array(128).fill(v));
    return m;
  });
  const st = {
    profile: 0,
    led: [3, 2, 4, 8, 0, 0, 0],
    side: [1, 2, 3, 7, 255, 0, 0],
    debounce: 5,
    autoOs: 0,
    sleep: [180, 0, 240, 0, 1800 & 0xff, 1800 >> 8, 2400 & 0xff, 2400 >> 8]
  };
  const macros = Array.from({ length: 50 }, () => new Uint8Array(256));
  const dks = Array.from({ length: PROFILES }, () =>
    Array.from({ length: 4 }, () => new Uint8Array(128))
  );
  let reply = new Uint8Array(64);
  const colBytes = (p: number, col: number) => {
    const vals = columns[p].get(col) ?? new Array(128).fill(0);
    return wide.has(col)
      ? Uint8Array.from(vals.flatMap(v => [v & 0xff, v >> 8]))
      : Uint8Array.from(vals);
  };
  const setColBytes = (p: number, col: number, offset: number, bytes: Uint8Array) => {
    const vals = columns[p].get(col);
    if (!vals) return;
    bytes.forEach((b, i) => {
      const o = offset + i;
      if (wide.has(col)) {
        const s = o >> 1;
        if (s < 128) vals[s] = o & 1 ? (vals[s] & 0xff) | (b << 8) : (vals[s] & 0xff00) | b;
      } else if (o < 128) vals[o] = b;
    });
  };
  const handle = (q: Uint8Array) => {
    const out = new Uint8Array(64);
    switch (q[0]) {
      case 0x8f:
        out[0] = 0x8f;
        out.set([RY_DEMO_ID & 0xff, RY_DEMO_ID >> 8, 0, 0], 1);
        out[7] = 0x09;
        out[8] = 0x03;
        break;
      case 0x80:
        out[0] = 0x80;
        break;
      case 0x84:
        out[0] = 0x84;
        out[1] = st.profile;
        break;
      case 0x04:
        st.profile = q[1];
        out[0] = 0x04;
        break;
      case 0x8a:
        out.set(keymaps[q[1]][q[4]].subarray(q[3] * 64, q[3] * 64 + 64));
        break;
      case 0x90:
        out.set(fn[q[2]].subarray(q[4] * 64, q[4] * 64 + 64));
        break;
      case 0x0a:
        keymaps[q[1]][q[6]].set(q.subarray(8, 12), q[2] * 4);
        break;
      case 0x10:
        fn[q[2]].set(q.subarray(8, 12), q[3] * 4);
        break;
      case 0xe5:
        if (q[1] === 10) {
          const b = dks[st.profile][q[3] >> 1];
          out.set(b.subarray((q[3] & 1) * 64, (q[3] & 1) * 64 + 64));
        } else out.set(colBytes(st.profile, q[1]).subarray(q[3] * 64, q[3] * 64 + 64));
        break;
      case 0x65: {
        const [, col, bulk, at] = q;
        if (col === 8) for (let i = 0; i < 4; i++) dks[st.profile][i][at] = q[8 + i];
        else if (bulk) setColBytes(st.profile, col, at * 56, q.subarray(8, 8 + 56));
        else
          setColBytes(
            st.profile,
            col,
            at * (wide.has(col) ? 2 : 1),
            q.subarray(8, wide.has(col) ? 10 : 9)
          );
        break;
      }
      case 0x07:
        st.led = [...q.subarray(1, 8)];
        break;
      case 0x87:
        out[0] = 0x87;
        out.set(st.led, 1);
        break;
      case 0x08:
        st.side = [...q.subarray(1, 8)];
        break;
      case 0x88:
        out[0] = 0x88;
        out.set(st.side, 1);
        break;
      case 0x06:
        st.debounce = q[1];
        break;
      case 0x86:
        out[0] = 0x86;
        out[1] = st.debounce;
        break;
      case 0x11:
        st.sleep = [...q.subarray(8, 16)];
        break;
      case 0x91:
        out[0] = 0x91;
        out.set(st.sleep, 8);
        break;
      case 0x17:
        st.autoOs = q[1];
        break;
      case 0x97:
        out[0] = 0x97;
        out[1] = st.autoOs;
        break;
      case 0x0b: {
        const start = q[2] * 56;
        macros[q[1]].set(q.subarray(8, 8 + Math.min(56, 256 - start)), start);
        break;
      }
      case 0x8b:
        out.set(macros[q[1]].subarray(q[2] * 64, q[2] * 64 + 64));
        break;
      default:
        out[0] = q[0];
    }
    reply = out;
  };
  return {
    async sendFeature(buf: Uint8Array) {
      await new Promise(r => setTimeout(r, 1));
      handle(buf);
    },
    async receiveFeature() {
      return reply;
    }
  };
}

/** The travel stream gen2 boards send by cable: `[0x1B, counts lo, hi, slot]` on report 5. */
function travelStream(slots: number[], unitMm: number): HidDeviceLike {
  const listeners = new Set<(e: { reportId: number; data: DataView }) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const started = performance.now();
  const moving = slots.slice(0, 5);
  const tick = () => {
    const ms = performance.now() - started;
    moving.forEach((slot, i) => {
      const counts = Math.round(wave(ms, i * 1.2, 3.6) / unitMm);
      const data = new DataView(Uint8Array.from([0x1b, counts & 0xff, counts >> 8, slot]).buffer);
      for (const l of listeners) l({ reportId: 5, data });
    });
  };
  return {
    opened: true,
    vendorId: 0,
    productId: 0,
    productName: 'demo travel',
    async open() {},
    async close() {},
    async sendReport() {},
    addEventListener(_type, l) {
      listeners.add(l);
      timer ??= setInterval(tick, 30);
    },
    removeEventListener(_type, l) {
      listeners.delete(l);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  } as HidDeviceLike;
}

export async function demoRongyuan(): Promise<KeyboardDriver> {
  const spec = await bundledDeps.findSpec(RY_DEMO_ID);
  const layout = spec?.keyLayout ? await bundledDeps.loadLayout(spec.keyLayout) : null;
  if (!spec || !layout) throw new Error('The demo board is missing from the board list.');
  const keys = layout.keys as Array<{ matrixIndex?: number; matrixEntry?: number[] }>;
  const slots = keys.flatMap((k, i) =>
    k.matrixIndex === undefined
      ? []
      : [{ slot: k.matrixIndex, entry: k.matrixEntry ?? [0, 0, 4 + (i % 26), 0] }]
  );
  const wire = new Wire(rongyuanBoard(slots), virtualClock());
  const driver = await RongyuanDriver.connect(
    wire,
    bundledDeps,
    // its own ids, so nothing stored for a real board on this computer is touched
    { vendorId: 0, productId: 0xde68, productName: 'Demo' },
    {
      streamDevices: [
        travelStream(
          // W A S D and space, by the usage in each key's factory entry
          [0x1a, 0x04, 0x16, 0x07, 0x2c].flatMap(u =>
            slots.filter(s => s.entry[2] === u).map(s => s.slot)
          ),
          // gen2 from firmware 3.00 counts hundredths
          0.01
        )
      ]
    }
  );
  return markDemo(driver);
}
