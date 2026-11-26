/**
 * RongYuan lighting, board settings and macros, ported from sharkfin
 * (docs/PROTOCOL.md "Lighting", "Settings", "Macros"; protocol/mod.rs).
 */

import { Checksum, packet, type Family } from './protocol';

// ------------------------------------------------------------- opcodes

/** Per-family opcodes beyond the keymap (sharkfin FamilyCmds). */
export type FamilyOps = {
  setDebounce: number;
  getDebounce: number;
  /** Byte of the debounce value in SET and in the GET reply. */
  debounceAt: number;
  /** yc500 options bitfield; withheld on gen2 (meanings not established). */
  kbOption: { set: number; get: number } | null;
  setMacro: number;
  reset: number;
  /** yc500 needs about 4 s after a factory reset. */
  resetSettleMs: number;
  reportRate: { set: number; get: number } | null;
  setSleep: number;
  getSleep: number;
  /** Where the four u16 sleep values sit in the GET reply (yc500 answers at 1, writes at 8). */
  sleepReplyAt: number;
};

export const LightOp = {
  SET_LED: 0x07,
  GET_LED: 0x87,
  SET_SIDE: 0x08,
  GET_SIDE: 0x88,
  SET_AUTO_OS: 0x17,
  GET_AUTO_OS: 0x97,
  GET_MACRO: 0x8b
} as const;

export function familyOps(family: Family): FamilyOps {
  return family === 'gen2'
    ? {
        setDebounce: 0x06,
        getDebounce: 0x86,
        debounceAt: 1,
        kbOption: null,
        setMacro: 0x0b,
        reset: 0x01,
        resetSettleMs: 4000,
        reportRate: { set: 0x03, get: 0x83 },
        setSleep: 0x11,
        getSleep: 0x91,
        sleepReplyAt: 8
      }
    : {
        setDebounce: 0x11,
        getDebounce: 0x91,
        debounceAt: 2,
        kbOption: { set: 0x06, get: 0x86 },
        setMacro: 0x16,
        reset: 0x02,
        resetSettleMs: 4000,
        reportRate: null,
        setSleep: 0x12,
        getSleep: 0x92,
        sleepReplyAt: 1
      };
}

// ------------------------------------------------------------- lighting

export type Rgb = [number, number, number];

/** One light setting in host units (speed 0 slowest .. 4 fastest). */
export type LedParam = {
  mode: number;
  speed: number;
  brightness: number;
  /** Direction / variant index. */
  option: number;
  /** Rainbow ("dazzle") instead of the colour. */
  rainbow: boolean;
  color: Rgb;
};

/** How one board reads LEDPARAM beyond the shared layout. */
export type LedWire = {
  /** Firmware reads the flags nibble the other way round (8 fixed, 7 rainbow). */
  swapped: boolean;
  /** Wire value of host speed 0; host `s` goes out as `speedMax - s`. */
  speedMax: number;
  brightnessMax: number;
};

export const ledWire = (family: Family, swapped: boolean, brightnessMax = 4): LedWire => ({
  swapped,
  speedMax: family === 'gen2' ? 4 : 5,
  brightnessMax: Math.max(1, brightnessMax)
});

const FLAG_FIXED = 7;
const FLAG_RAINBOW = 8;
const MODE_USER_PICTURE = 13;
const MODE_SCREEN_COLOR = 21;
const MODE_MUSIC_2 = 22;
const MODE_MUSIC_3 = 20;
const SIDE_MODE_NEON = 3;
/** Below this the firmware renders all LEDs off. */
const COLOR_FLOOR = 8;

const flagsPair = (swapped: boolean) =>
  swapped
    ? { fixed: FLAG_RAINBOW, rainbow: FLAG_FIXED }
    : { fixed: FLAG_FIXED, rainbow: FLAG_RAINBOW };

const PRESETS: Rgb[] = [
  [0xff, 0x00, 0x00],
  [0xff, 0x80, 0x00],
  [0xff, 0xff, 0x00],
  [0x00, 0xff, 0x00],
  [0x00, 0xff, 0xff],
  [0x00, 0x00, 0xff],
  [0xff, 0x00, 0xff]
];
/** Preset colours 0..6 on the swapped-nibble lineage. */
const PRESETS_SWAPPED: Rgb[] = [
  [0xff, 0x00, 0x00],
  [0x00, 0xff, 0x00],
  [0x00, 0x00, 0xff],
  [0xff, 0x55, 0x00],
  [0xff, 0x00, 0xff],
  [0xff, 0xbb, 0x00],
  [0xff, 0xff, 0xdd]
];

/** Floor near-black, and send white as 0xFAFAFA. */
function wireColor([r, g, b]: Rgb): Rgb {
  if (Math.max(r, g, b) < COLOR_FLOOR) return [COLOR_FLOOR, COLOR_FLOOR, COLOR_FLOOR];
  if (r === 0xff && g === 0xff && b === 0xff) return [0xfa, 0xfa, 0xfa];
  return [r & 0xff, g & 0xff, b & 0xff];
}

function hostColor(r: number, g: number, b: number): Rgb {
  return r === 0xfa && g === 0xfa && b === 0xfa ? [0xff, 0xff, 0xff] : [r, g, b];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

export function ledPacket(p: LedParam, wire: LedWire): Uint8Array {
  const { fixed, rainbow } = flagsPair(wire.swapped);
  let [r, g, b] = wireColor(p.color);
  const option = (p.option & 0x0f) << 4;
  let flags: number;
  if (p.mode === MODE_USER_PICTURE) {
    [r, g, b] = [0, 200, 200];
    flags = option;
  } else if (p.mode === MODE_SCREEN_COLOR) flags = 0;
  else if (p.mode === MODE_MUSIC_2 || p.mode === MODE_MUSIC_3) flags = option | (p.rainbow ? 0 : 4);
  else flags = option | (p.rainbow ? rainbow : fixed);
  const speed = Math.max(0, wire.speedMax - clamp(p.speed, 0, 4));
  return packet(
    LightOp.SET_LED,
    [p.mode, speed, clamp(p.brightness, 0, wire.brightnessMax), flags, r, g, b],
    Checksum.Bit8
  );
}

export function parseLed(reply: Uint8Array, wire: LedWire): LedParam | null {
  if (reply.length < 8 || reply[0] !== LightOp.GET_LED) return null;
  const { fixed, rainbow: rainbowFlag } = flagsPair(wire.swapped);
  const mode = reply[1];
  const nibble = reply[4] & 0x0f;
  let color = hostColor(reply[5], reply[6], reply[7]);
  const music = mode === MODE_MUSIC_2 || mode === MODE_MUSIC_3;
  const rainbow = music ? nibble === 0 : nibble === rainbowFlag;
  if (
    !rainbow &&
    nibble !== fixed &&
    !music &&
    mode !== MODE_USER_PICTURE &&
    mode !== MODE_SCREEN_COLOR
  ) {
    const preset = (wire.swapped ? PRESETS_SWAPPED : PRESETS)[nibble];
    if (preset) color = [...preset];
  }
  return {
    mode,
    speed: Math.min(4, Math.max(0, wire.speedMax - reply[2])),
    brightness: Math.min(reply[3], wire.brightnessMax),
    option: reply[4] >> 4,
    rainbow,
    color
  };
}

/** Edge light: LEDPARAM's layout, its own modes, speed not inverted. */
export function sidePacket(p: LedParam, swapped: boolean): Uint8Array {
  const { fixed, rainbow } = flagsPair(swapped);
  const [r, g, b] = wireColor(p.color);
  const flags =
    p.mode === SIDE_MODE_NEON ? rainbow : ((p.option & 0x0f) << 4) | (p.rainbow ? rainbow : fixed);
  return packet(
    LightOp.SET_SIDE,
    [p.mode, clamp(p.speed, 0, 4), clamp(p.brightness, 0, 4), flags, r, g, b],
    Checksum.Bit8
  );
}

export function parseSide(reply: Uint8Array, swapped: boolean): LedParam | null {
  if (reply.length < 8 || reply[0] !== LightOp.GET_SIDE) return null;
  const { fixed, rainbow: rainbowFlag } = flagsPair(swapped);
  const nibble = reply[4] & 0x0f;
  let color = hostColor(reply[5], reply[6], reply[7]);
  const rainbow = nibble === rainbowFlag;
  if (!rainbow && nibble !== fixed) {
    const preset = (swapped ? PRESETS_SWAPPED : PRESETS)[nibble];
    if (preset) color = [...preset];
  }
  return {
    mode: reply[1],
    speed: Math.min(reply[2], 4),
    brightness: Math.min(reply[3], 4),
    option: reply[4] >> 4,
    rainbow,
    color
  };
}

// ------------------------------------------------------------- settings

/** yc500 options bitfield (reply byte 2). Mac mode is read-only. */
export type KbOptions = {
  winLock: boolean;
  macMode: boolean;
  wasdSwap: boolean;
  backlightOff: boolean;
  sideLightOff: boolean;
};

export function parseKbOptions(reply: Uint8Array, getOp: number): KbOptions | null {
  if (reply.length < 5 || reply[0] !== getOp) return null;
  const f = reply[2];
  return {
    winLock: !!(f & 1),
    macMode: !!(f & 2),
    wasdSwap: !!(f & 8),
    backlightOff: !!(f & 16),
    sideLightOff: !!(f & 32)
  };
}

/** Read-modify-write: keeps the bits OpenHE does not model (keyboard lock, mode). */
export function kbOptionsPacket(o: KbOptions, setOp: number, current: Uint8Array): Uint8Array {
  const flags =
    (current[2] & 0b1100_0110) |
    (o.winLock ? 1 : 0) |
    (o.wasdSwap ? 8 : 0) |
    (o.backlightOff ? 16 : 0) |
    (o.sideLightOff ? 32 : 0);
  return packet(setOp, [0, flags, current[3], current[4]]);
}

export function debouncePacket(ops: FamilyOps, value: number): Uint8Array {
  const v = clamp(value, 1, 10);
  return packet(ops.setDebounce, ops.debounceAt === 1 ? [v] : [0, v]);
}

/** Wireless sleep timeouts in seconds (sharkfin SleepTimes). */
export type SleepTimes = { sleepBt: number; sleep24: number; deepBt: number; deep24: number };
const SLEEP_ORDER = ['sleepBt', 'sleep24', 'deepBt', 'deep24'] as const;

/** Four u16 LE at bytes 8..15 on both families. */
export function sleepPacket(ops: FamilyOps, t: SleepTimes): Uint8Array {
  const buf = packet(ops.setSleep);
  SLEEP_ORDER.forEach((k, i) => {
    const v = clamp(t[k], 0, 0xffff);
    buf[8 + i * 2] = v & 0xff;
    buf[9 + i * 2] = v >> 8;
  });
  // the checksum covers bytes 0..6 only, so the values do not change it
  return buf;
}

export function parseSleep(reply: Uint8Array, ops: FamilyOps): SleepTimes | null {
  const at = ops.sleepReplyAt;
  if (reply.length < at + 8 || reply[0] !== ops.getSleep) return null;
  const u16 = (i: number) => reply[at + i] | (reply[at + i + 1] << 8);
  return { sleepBt: u16(0), sleep24: u16(2), deepBt: u16(4), deep24: u16(6) };
}

// ------------------------------------------------------------- macros

export const RY_MACRO_SLOTS = 50;
export const RY_MACRO_BYTES = 256;
const MACRO_PAGE_DATA = 56;
const MOUSE_BUTTON_BASE = 0xf0;
const MOUSE_MOVE = 0xf9;
const KEY_USAGE_MAX = 0xef;

/** Key usage 0x04..0xEF, or mouse button 0..4 (left, right, middle, back, forward). */
export type RyMacroEvent =
  | { kind: 'key'; usage: number; pressed: boolean; delayMs: number }
  | { kind: 'mouse'; button: number; pressed: boolean; delayMs: number }
  | { kind: 'move'; dx: number; dy: number; delayMs: number };

export type RyMacro = { repeat: number; events: RyMacroEvent[] };

function pushPress(out: number[], code: number, pressed: boolean, delayMs: number) {
  const hi = pressed ? 0x80 : 0;
  const d = clamp(delayMs, 0, 0xffff);
  // short form only for 1..127: a zero low byte marks the long form
  if (d >= 1 && d <= 127) out.push(code, hi | d);
  else out.push(code, hi, d & 0xff, d >> 8);
}

export function macroToBlob(m: RyMacro): Uint8Array {
  const stream: number[] = [];
  for (const e of m.events) {
    if (e.kind === 'key') {
      if (e.usage < 0x04 || e.usage > KEY_USAGE_MAX)
        throw new RangeError(`key usage 0x${e.usage.toString(16)} out of range`);
      pushPress(stream, e.usage, e.pressed, e.delayMs);
    } else if (e.kind === 'mouse') {
      if (e.button < 0 || e.button > 4)
        throw new RangeError(`mouse button ${e.button} out of range`);
      pushPress(stream, MOUSE_BUTTON_BASE + e.button, e.pressed, e.delayMs);
    } else {
      stream.push(MOUSE_MOVE, clamp(e.delayMs, 0, 255), e.dx & 0xff, e.dy & 0xff);
    }
  }
  if (stream.length > RY_MACRO_BYTES - 6) {
    throw new RangeError(
      `macro too long: ${stream.length} bytes of events, max ${RY_MACRO_BYTES - 6}`
    );
  }
  const blob = new Uint8Array(RY_MACRO_BYTES);
  const repeat = clamp(m.repeat, 0, 0xffff);
  blob[0] = repeat & 0xff;
  blob[1] = repeat >> 8;
  blob.set(stream, 2);
  return blob;
}

/** Lenient: stops at the terminator, the end, or the first unknown code. */
export function macroFromBlob(blob: Uint8Array): RyMacro {
  const repeat = blob[0] | (blob[1] << 8);
  const events: RyMacroEvent[] = [];
  let i = 2;
  while (i + 1 < RY_MACRO_BYTES) {
    const code = blob[i];
    if (code === 0) break;
    if (code === MOUSE_MOVE) {
      if (i + 3 >= RY_MACRO_BYTES) break;
      events.push({
        kind: 'move',
        delayMs: blob[i + 1],
        dx: (blob[i + 2] << 24) >> 24,
        dy: (blob[i + 3] << 24) >> 24
      });
      i += 4;
      continue;
    }
    const pressed = !!(blob[i + 1] & 0x80);
    const low = blob[i + 1] & 0x7f;
    let delayMs: number;
    if (low) {
      delayMs = low;
      i += 2;
    } else {
      if (i + 3 >= RY_MACRO_BYTES) break;
      delayMs = blob[i + 2] | (blob[i + 3] << 8);
      i += 4;
    }
    if (code >= 0x04 && code <= KEY_USAGE_MAX)
      events.push({ kind: 'key', usage: code, pressed, delayMs });
    else if (code >= MOUSE_BUTTON_BASE && code <= MOUSE_BUTTON_BASE + 4)
      events.push({ kind: 'mouse', button: code - MOUSE_BUTTON_BASE, pressed, delayMs });
    else break;
  }
  return { repeat, events };
}

/** Pages the blob occupies (the vendor sends only those). */
export function macroPages(blob: Uint8Array): number {
  let last = -1;
  for (let p = 0; p * MACRO_PAGE_DATA < RY_MACRO_BYTES; p++) {
    if (blob.subarray(p * MACRO_PAGE_DATA, (p + 1) * MACRO_PAGE_DATA).some(b => b !== 0)) last = p;
  }
  return last + 1 || 1;
}

export function macroWritePacket(
  op: number,
  slot: number,
  page: number,
  last: boolean,
  blob: Uint8Array
) {
  const buf = packet(op, [slot, page, MACRO_PAGE_DATA, last ? 1 : 0, 0]);
  const start = page * MACRO_PAGE_DATA;
  buf.set(blob.subarray(start, Math.min(start + MACRO_PAGE_DATA, RY_MACRO_BYTES)), 8);
  return buf;
}

export const macroReadPacket = (slot: number, page: number) =>
  packet(LightOp.GET_MACRO, [slot, page]);

/** Keymap entry binding a key to a macro slot. Modes: 0 repeat count, 1 toggle, 2 while held. */
export const MACRO_ENTRY_TAG = 9;
export type RyMacroMode = 0 | 1 | 2;

// ------------------------------------------------------------- per-key colours

/** Mode that shows the per-key pattern (sharkfin PER_KEY_MODE). */
export const RY_PER_KEY_MODE = MODE_USER_PICTURE;
/** 128 matrix slots x RGB; gen2 carries the first 126. */
export const RY_PER_KEY_SLOTS = 128;
const USERPIC_OP = 0x0c;
const USERPIC_PAGE = 56;
const BULK_SENTINEL = 0xff;

/**
 * The per-key pattern as write packets (sharkfin protocol/mod.rs
 * userpic_write_packet, gen2.rs userpic_packets). yc500: seven pages with the
 * total length at bytes 2-3 and the page at byte 4. gen2: pattern slot 0,
 * 0xFF at byte 2 (anything else commits stale data), page, length, last flag;
 * the slot is committed to flash when the last page arrives. The board does
 * not read the pattern back.
 */
export function userpicPackets(family: Family, blob: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (family === 'gen2') {
    const data = blob.subarray(0, (RY_PER_KEY_SLOTS - 2) * 3);
    const pages = Math.ceil(data.length / USERPIC_PAGE);
    for (let page = 0; page < pages; page++) {
      const chunk = data.subarray(page * USERPIC_PAGE, (page + 1) * USERPIC_PAGE);
      const buf = packet(USERPIC_OP, [
        0,
        BULK_SENTINEL,
        page,
        chunk.length,
        page === pages - 1 ? 1 : 0
      ]);
      buf.set(chunk, 8);
      out.push(buf);
    }
  } else {
    const len = RY_PER_KEY_SLOTS * 3;
    for (let page = 0; page * USERPIC_PAGE < len; page++) {
      const buf = packet(USERPIC_OP, [0, len & 0xff, len >> 8, page, 0, 0]);
      buf.set(blob.subarray(page * USERPIC_PAGE, Math.min((page + 1) * USERPIC_PAGE, len)), 8);
      out.push(buf);
    }
  }
  return out;
}
