/**
 * Sparklink demo: a generic 75 % "Demo board" answering protocol-keyboard-v2
 * in memory, with live travel on WASD and space.
 */

import { SparklinkDriver } from '../sparklink/driver';
import type { ReportTransport } from '../transport';
import type { KeyboardDriver } from '../types';
import { le, markDemo, wave } from './shared';

/** [HID usage, width code] per key; width codes 1 1u, 2 1.25, 3 1.5, 4 1.75, 5 2, 6 2.25, 9 6.25. */
const SL_75: Array<Array<[number, number]>> = [
  [
    [0x29, 1],
    ...Array.from({ length: 12 }, (_, i) => [0x3a + i, 1] as [number, number]),
    [0x46, 1],
    [0x49, 1],
    [0x4c, 1]
  ],
  [
    [0x35, 1],
    ...Array.from({ length: 10 }, (_, i) => [0x1e + i, 1] as [number, number]),
    [0x2d, 1],
    [0x2e, 1],
    [0x2a, 5],
    [0x4a, 1]
  ],
  [
    [0x2b, 3],
    ...[0x14, 0x1a, 0x08, 0x15, 0x17, 0x1c, 0x18, 0x0c, 0x12, 0x13, 0x2f, 0x30].map(
      c => [c, 1] as [number, number]
    ),
    [0x31, 3],
    [0x4b, 1]
  ],
  [
    [0x39, 4],
    ...[0x04, 0x16, 0x07, 0x09, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x33, 0x34].map(
      c => [c, 1] as [number, number]
    ),
    [0x28, 6],
    [0x4e, 1]
  ],
  [
    [0xe1, 6],
    ...[0x1d, 0x1b, 0x06, 0x19, 0x05, 0x11, 0x10, 0x36, 0x37, 0x38].map(
      c => [c, 1] as [number, number]
    ),
    [0xe5, 4],
    [0x52, 1],
    [0x4d, 1]
  ],
  [
    [0xe0, 2],
    [0xe3, 2],
    [0xe2, 2],
    [0x2c, 9],
    [0xe6, 1],
    [0xf101, 1],
    [0xe4, 1],
    [0x50, 1],
    [0x51, 1],
    [0x4f, 1]
  ]
];
const SL_WIDTH: Record<number, number> = { 1: 1, 2: 1.25, 3: 1.5, 4: 1.75, 5: 2, 6: 2.25, 9: 6.25 };

function sparklinkBoard(): ReportTransport {
  const PROFILES = 4;
  const style = Array.from({ length: 8 }, () => new Array(21).fill(0));
  const defaults = Array.from({ length: 8 }, () => new Array(21).fill(0));
  SL_75.forEach((row, r) => {
    let x = 0;
    row.forEach(([code, ratio], c) => {
      style[r][c] = (((r * 4) & 0x1f) << 11) | (((x * 4) & 0x7f) << 4) | ratio;
      defaults[r][c] = code;
      x += SL_WIDTH[ratio];
    });
  });
  type Perf = number[];
  // Gateron Magnetic Jade from Sparklink's switch catalog
  const perfOf = (): Perf => [0, 1500, 1200, 300, 150, 150, 0, 0, 0, 2, 4112, 3430, 22800];
  const cfg = Array.from({ length: PROFILES }, () => ({
    keys: Array.from({ length: 4 }, (_, layer) =>
      Array.from({ length: 8 }, (_, r) =>
        layer === 0 ? defaults[r].slice() : new Array(21).fill(1)
      )
    ),
    perf: new Map<string, Perf>(),
    hk: new Map<string, number[]>()
  }));
  const st = { profile: 0, rate: 3 };
  const macros = Array.from({ length: 16 }, () => ({
    h: [0, 0, 0, 0, 0, 0],
    a: new Array(60 * 4).fill(0)
  }));
  const light: Record<number, { base: number[]; pal: number[][] }> = {
    0: {
      base: [3, 10, 80, 50, 0, 3],
      pal: Array.from({ length: 8 }, (_, i) => [255 - i * 30, 120, i * 30, 255])
    },
    1: { base: [1, 1, 60, 40, 0, 0], pal: Array.from({ length: 8 }, () => [255, 80, 0, 255]) }
  };
  const cells = Array.from({ length: 135 }, () => [0, 0, 0, 0]);
  const cal: { since: number | null } = { since: null };
  const started = performance.now();

  const reply = (q: Uint8Array): Uint8Array => {
    const o = new Uint8Array(64);
    o[0] = q[0];
    o[1] = q[1];
    const p = cfg[st.profile];
    switch ((q[0] << 8) | q[1]) {
      case 0x0102:
        o.set([0, 0, 0xde, 0x00, 0x00, 0x01, 1, 0, 0, 0], 2);
        break;
      case 0x0103:
        o.set([0x02, 0x01, 0x01, 0], 2);
        break;
      case 0x0305:
        o[2] = q[2];
        style[q[2]].forEach((w, i) => o.set(le(w), 3 + i * 2));
        break;
      case 0x0301:
        o[2] = q[2];
        o[3] = q[3];
        p.keys[q[2]][q[3]].forEach((k, i) => o.set(le(k), 4 + i * 2));
        break;
      case 0x0306:
        o[3] = q[3];
        defaults[q[3]].forEach((k, i) => o.set(le(k), 4 + i * 2));
        break;
      case 0x0302:
        for (let i = 0; i < 21; i++) p.keys[q[2]][q[3]][i] = q[4 + i * 2] | (q[5 + i * 2] << 8);
        break;
      case 0x0401: {
        const k = `${q[2]}:${q[3]}`;
        if (!style[q[2]]?.[q[3]]) break;
        const v = p.perf.get(k) ?? perfOf();
        o[2] = q[2];
        o[3] = q[3];
        o[4] = v[0];
        v.slice(1, 8).forEach((x, i) => o.set(le(x), 5 + i * 2));
        o[19] = v[8];
        o[20] = v[9];
        o.set([...le(v[10]), ...le(v[11]), ...le(v[12])], 21);
        break;
      }
      case 0x0402: {
        const u = (i: number) => q[i] | (q[i + 1] << 8);
        p.perf.set(`${q[2]}:${q[3]}`, [
          q[4],
          u(5),
          u(7),
          u(9),
          u(11),
          u(13),
          u(15),
          u(17),
          q[19],
          q[20],
          u(21),
          u(23),
          u(25)
        ]);
        break;
      }
      case 0x0403: {
        o[2] = q[2];
        o[3] = q[3];
        if (q[2] === 2) {
          // calibrating: keys come in over a few seconds, as if pressed in turn
          const t = cal.since === null ? Infinity : (performance.now() - cal.since) / 120;
          for (let c = 0; c < 21; c++) o.set(le(q[3] * 16 + c < t ? 2 : 1), 4 + c * 2);
          break;
        }
        const ms = performance.now() - started;
        // a few keys pressing in turn: WASD and space
        const moving: Record<string, number> = {
          '2:2': 0,
          '3:1': 1.2,
          '3:2': 2.4,
          '3:3': 3.6,
          '5:3': 4.8
        };
        for (let c = 0; c < 21; c++) {
          const ph = moving[`${q[3]}:${c}`];
          o.set(le(ph === undefined ? 0 : Math.round(wave(ms, ph, 3.6) * 1000)), 4 + c * 2);
        }
        break;
      }
      case 0x0202:
        o[3] = q[2];
        break;
      case 0x0201:
        o[3] = 0xff;
        break;
      case 0x0203:
        if (q[2] === 0) o[3] = PROFILES;
        else if (q[2] === 1) o[3] = st.profile;
        else st.profile = o[3] = q[3];
        break;
      case 0x0205:
        if (q[2] === 0) {
          o[3] = 4;
          o.set([0, 1, 3, 6], 4);
        } else if (q[2] === 1) o[3] = st.rate;
        else st.rate = o[3] = q[3];
        break;
      case 0x020c:
        o[3] = 10;
        break;
      case 0x020e:
        o[3] = 16;
        o.set(le(960), 4);
        break;
      case 0x0208:
        o[3] = 2;
        o.set([0, 87, 6, 21, 1, 12, 1, 12], 4);
        break;
      case 0x020a:
        o[3] = 1;
        break;
      case 0x0207:
        // no list of its own: keys take switches from the catalog
        o[3] = 0;
        break;
      case 0x0206:
        cal.since = q[2] === 0 ? performance.now() : null;
        break;
      case 0x0501: {
        const a = light[q[2]];
        o[2] = q[2];
        o[3] = q[3];
        if (!a) o[1] = 0xff;
        else if (q[3] === 0) o.set(a.base, 4);
        else if (q[3] === 1) o.set(a.pal.flat(), 4);
        break;
      }
      case 0x0502: {
        const a = light[q[2]];
        if (q[3] === 0) a.base = [...q.subarray(4, 10)];
        else if (q[3] === 1)
          a.pal = Array.from({ length: 8 }, (_, i) => [...q.subarray(4 + i * 4, 8 + i * 4)]);
        o[2] = q[2];
        o[3] = q[3];
        break;
      }
      case 0x0503:
        o[2] = q[2];
        o[3] = q[3];
        o.set(cells.slice(q[3] * 15, q[3] * 15 + 15).flat(), 4);
        break;
      case 0x0504:
        for (let i = 0; i < 15; i++) cells[q[3] * 15 + i] = [...q.subarray(4 + i * 4, 8 + i * 4)];
        o[2] = q[2];
        o[3] = q[3];
        break;
      case 0x0601: {
        o[2] = q[2];
        o[3] = q[3];
        const r = p.hk.get(`${q[2]}:${q[3]}`);
        if (r) o.set(r.slice(4), 4);
        break;
      }
      case 0x0602: {
        const k = `${q[2]}:${q[3]}`;
        if (q[4] === 0) p.hk.delete(k);
        else p.hk.set(k, [...q.subarray(0, 40)]);
        o[2] = q[2];
        o[3] = q[3];
        break;
      }
      case 0x0701:
        o[2] = q[2];
        o.set(macros[q[2]].h, 3);
        break;
      case 0x0702:
        macros[q[2]].h = [...q.subarray(3, 9)];
        o[2] = q[2];
        break;
      case 0x0703:
        o[2] = q[2];
        o[3] = q[3];
        o.set(macros[q[2]].a.slice(q[3] * 60, q[3] * 60 + 60), 4);
        break;
      case 0x0704:
        for (let i = 0; i < 60; i++) macros[q[2]].a[q[3] * 60 + i] = q[4 + i];
        o[2] = q[2];
        o[3] = q[3];
        break;
      default:
        o[1] = 0xff;
    }
    return o;
  };

  return {
    async exchange(report, _timeoutMs, accept) {
      await new Promise(r => setTimeout(r, 1));
      const r = reply(report);
      if (accept && !accept(r)) throw new Error('Keyboard did not answer');
      return r;
    },
    async close() {}
  } as ReportTransport;
}

export async function demoSparklink(): Promise<KeyboardDriver> {
  const driver = await SparklinkDriver.connect(sparklinkBoard(), {
    vendorId: 0x1ca6,
    productId: 0xde00,
    productName: 'Demo board'
  });
  return markDemo(driver);
}
