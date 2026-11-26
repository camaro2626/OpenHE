/**
 * Sparklink (星闪悦动) keyboard protocol, v2: 64-byte output reports on usage
 * page 0xFFB0, usage 1; each answered by one 64-byte input report that echoes
 * the group and sub-command in bytes 0..1, data from byte 2.
 *
 * Ported from Sparklink's own MIT-licensed protocol source,
 * @sparklinkplayjoy/protocol-keyboard-v2 1.0.24 (constants/byte.ts,
 * constants/globalByte.ts, pack/*.ts, recdata/*.ts); MIT license, see
 * LICENSES/MIT-sparklink.txt. Firmware-upgrade commands (group 0x08) are
 * deliberately not here.
 */

export const SL_USAGE_PAGE = 0xffb0;
export const SL_USAGE = 0x01;
export const SL_REPORT_LEN = 64;
/** Keys per layout row in every row-addressed command. */
export const SL_COLS = 21;
/** Rows OpenHE asks a board about (the protocol addresses up to 8). */
export const SL_MAX_ROWS = 8;
/** Base layer plus Fn1..Fn3. */
export const SL_LAYERS = 4;

export const Group = {
  DEVICE: 0x01,
  GLOBAL: 0x02,
  LAYOUT: 0x03,
  PERFORMANCE: 0x04,
  LIGHTING: 0x05,
  HIGHER_KEY: 0x06,
  MACRO: 0x07
} as const;

export const DeviceCmd = { PROTOCOL: 0x01, INFO: 0x02, FEATURE: 0x03 } as const;

export const LayoutCmd = {
  GET_ROW: 0x01,
  SET_ROW: 0x02,
  GET_KEY: 0x03,
  SET_KEY: 0x04,
  GET_STYLE: 0x05,
  GET_DEFAULT: 0x06
} as const;

export const PerfCmd = { GET: 0x01, SET: 0x02, AXIS_DATA: 0x03 } as const;
export const AxisData = { ADC: 0x00, ROUTE: 0x01, CALIBRATE: 0x02, KEY_STATUS: 0x03 } as const;
/** Trigger mode: plain, Rapid Trigger, Rapid Trigger with continuous off ("interval RT"). */
export const TriggerMode = { NORMAL: 0x00, RT: 0x01, INTERVAL_RT: 0x02 } as const;

export const GlobalCmd = {
  RESET: 0x01,
  SAVE: 0x02,
  CONFIG: 0x03,
  SYSTEM: 0x04,
  REPORT_RATE: 0x05,
  CALIBRATION: 0x06,
  AXIS_LIBRARY: 0x07,
  LIGHT_AREAS: 0x08,
  DOUBLE_LIGHTING: 0x0a,
  RT_PRECISION: 0x0c
} as const;
/** Read list / read / write, the third byte of global reads and writes. */
export const CRW = { LIST: 0x00, READ: 0x01, WRITE: 0x02 } as const;
/** What a save (or a factory reset) covers. */
export const Area = {
  ALL: 0x00,
  CALIBRATION: 0x01,
  PERFORMANCE: 0x02,
  LIGHTING: 0x03,
  LAYOUT: 0x04,
  HIGHER_KEY: 0x05,
  MACRO: 0x06,
  AXIS: 0x07
} as const;
/** Report-rate codes, highest first. */
export const REPORT_RATES_HZ = [8000, 4000, 2000, 1000, 500, 250, 125] as const;

export function packet(bytes: readonly number[]): Uint8Array {
  const buf = new Uint8Array(SL_REPORT_LEN);
  buf.set(bytes.slice(0, SL_REPORT_LEN).map(b => b & 0xff));
  return buf;
}

const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

// ------------------------------------------------------------ device

export type SlDeviceInfo = {
  type: number;
  subType: number;
  boardId: number;
  appVersion: string;
  pcbVersion: string;
  serial: string;
  buildDate: string;
};

export function parseDeviceInfo(d: Uint8Array): SlDeviceInfo {
  const boardId = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
  return {
    type: d[2],
    subType: d[3],
    boardId,
    appVersion: Array.from(d.subarray(8, 12)).join('.'),
    pcbVersion: Array.from(d.subarray(12, 16)).join('-'),
    serial: Array.from(d.subarray(17, 29)).join(''),
    buildDate: new TextDecoder().decode(d.subarray(29, 41).filter(b => b !== 0))
  };
}

export type SlFeatures = {
  magnetic: boolean;
  magnetic3d: boolean;
  wireless: boolean;
  rgb: boolean;
  knob: boolean;
  screen: boolean;
  gamepad: boolean;
};

export function parseFeatures(d: Uint8Array): SlFeatures {
  return {
    magnetic: !!(d[2] & 0x02),
    magnetic3d: !!(d[2] & 0x10),
    wireless: !!(d[3] & 0x06),
    rgb: !!(d[4] & 0x01),
    knob: !!(d[4] & 0x02),
    screen: !!(d[5] & 0x03),
    gamepad: !!(d[5] & 0x20)
  };
}

// ------------------------------------------------------------ layout

export type SlKeyStyle = {
  /** Position in key units (the wire carries quarter units). */
  row: number;
  col: number;
  /** Width code: 0 none, 1 1u, 2 1.25u ... 9 6.25u, 10 a 2u-tall key, 12 knob, 13..15 screen. */
  ratio: number;
};

/** Width in key units by width code (protocol-keyboard-v2's KeyLayoutStyle). */
export const KEY_WIDTH: Readonly<Record<number, number>> = {
  1: 1,
  2: 1.25,
  3: 1.5,
  4: 1.75,
  5: 2,
  6: 2.25,
  7: 2.5,
  8: 2.75,
  9: 6.25,
  10: 1
};

/** One row of key positions: 21 little-endian words, row:5 col:7 ratio:4. */
export function parseStyleRow(d: Uint8Array): SlKeyStyle[] {
  const out: SlKeyStyle[] = [];
  for (let i = 0; i < SL_COLS; i++) {
    const v = u16(d, 3 + i * 2);
    out.push({ row: ((v >> 11) & 0x1f) / 4, col: ((v >> 4) & 0x7f) / 4, ratio: v & 0x0f });
  }
  return out;
}

/** One row of 21 keycodes, little-endian, from `from`. */
export function parseKeycodeRow(d: Uint8Array, from = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i < SL_COLS; i++) out.push(u16(d, from + i * 2));
  return out;
}

export const getStyleRow = (row: number) => packet([Group.LAYOUT, LayoutCmd.GET_STYLE, row]);
export const getKeyRow = (layer: number, row: number) =>
  packet([Group.LAYOUT, LayoutCmd.GET_ROW, layer, row]);
export const setKeyRow = (layer: number, row: number, codes: readonly number[]) =>
  packet([Group.LAYOUT, LayoutCmd.SET_ROW, layer, row, ...codes.flatMap(le16)]);
/** Factory keymap: `system` 0 Windows, 1 macOS; `fn` the layer. */
export const getDefaultRow = (fn: number, row: number, system = 0) =>
  packet([Group.LAYOUT, LayoutCmd.GET_DEFAULT, ((system & 0x0f) << 4) | (fn & 0x0f), row]);

// ------------------------------------------------------------ performance

/** One key's trigger settings, micrometres on the wire. */
export type SlPerformance = {
  mode: number;
  /** Actuation point with plain triggering. */
  normalPress: number;
  /** Release point with plain triggering. */
  normalRelease: number;
  /** Actuation point with Rapid Trigger. */
  rtFirstTouch: number;
  rtPress: number;
  rtRelease: number;
  /** Top dead zone. */
  pressDead: number;
  /** Bottom dead zone. */
  releaseDead: number;
  /** Switch id, calibration flag and switch calibration: written back as read. */
  axis: number;
  calibrate: number;
  axisV2Id: number;
  axisRangeMax: number;
  axisCoefficient: number;
};

export const getPerformance = (row: number, col: number) =>
  packet([Group.PERFORMANCE, PerfCmd.GET, row, col]);

export function parsePerformance(d: Uint8Array): SlPerformance {
  return {
    mode: d[4],
    normalPress: u16(d, 5),
    normalRelease: u16(d, 7),
    rtFirstTouch: u16(d, 9),
    rtPress: u16(d, 11),
    rtRelease: u16(d, 13),
    pressDead: u16(d, 15),
    releaseDead: u16(d, 17),
    axis: d[19],
    calibrate: d[20],
    axisV2Id: u16(d, 21),
    axisRangeMax: u16(d, 23),
    axisCoefficient: u16(d, 25)
  };
}

export function setPerformance(row: number, col: number, p: SlPerformance): Uint8Array {
  const um = (v: number) => le16(Math.max(0, Math.min(0xffff, Math.round(v))));
  return packet([
    Group.PERFORMANCE,
    PerfCmd.SET,
    row,
    col,
    p.mode,
    ...um(p.normalPress),
    ...um(p.normalRelease),
    ...um(p.rtFirstTouch),
    ...um(p.rtPress),
    ...um(p.rtRelease),
    ...um(p.pressDead),
    ...um(p.releaseDead),
    p.axis,
    // the vendor app always sends 0 here, so no key is left flagged as calibrating
    0,
    ...le16(p.axisV2Id),
    ...le16(p.axisRangeMax),
    ...le16(p.axisCoefficient)
  ]);
}

/** Live travel of one row, micrometres. */
export const getRoute = (row: number) =>
  packet([Group.PERFORMANCE, PerfCmd.AXIS_DATA, AxisData.ROUTE, row]);
export const getAdc = (row: number) =>
  packet([Group.PERFORMANCE, PerfCmd.AXIS_DATA, AxisData.ADC, row]);
/** Each key's calibration state in one row; 2 means calibrated. */
export const getCalibrationRow = (row: number) =>
  packet([Group.PERFORMANCE, PerfCmd.AXIS_DATA, AxisData.CALIBRATE, row]);
export const CALIBRATED = 2;

export function parseAxisRow(d: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < SL_COLS; i++) out.push(u16(d, 4 + i * 2));
  return out;
}

// ------------------------------------------------------------ global

export const save = (area: number) => packet([Group.GLOBAL, GlobalCmd.SAVE, area]);
export const factoryReset = (area: number = Area.ALL) =>
  packet([Group.GLOBAL, GlobalCmd.RESET, area]);
export const configList = () => packet([Group.GLOBAL, GlobalCmd.CONFIG, CRW.LIST]);
export const configRead = () => packet([Group.GLOBAL, GlobalCmd.CONFIG, CRW.READ]);
export const configWrite = (index: number) =>
  packet([Group.GLOBAL, GlobalCmd.CONFIG, CRW.WRITE, index]);
export const rateList = () => packet([Group.GLOBAL, GlobalCmd.REPORT_RATE, CRW.LIST]);
export const rateRead = () => packet([Group.GLOBAL, GlobalCmd.REPORT_RATE, CRW.READ]);
export const rateWrite = (code: number) =>
  packet([Group.GLOBAL, GlobalCmd.REPORT_RATE, CRW.WRITE, code]);
export const rtPrecision = () => packet([Group.GLOBAL, GlobalCmd.RT_PRECISION, 0x00]);
/**
 * Calibration: start (the board learns each key's rest and bottom-out while
 * they are pressed) and finish; save Area.CALIBRATION afterwards.
 */
export const calibration = (open: boolean) =>
  packet([Group.GLOBAL, GlobalCmd.CALIBRATION, open ? 0x00 : 0x01]);
/**
 * The board's own switch list. Empty means "unlimited switches": each key
 * stores its switch as axisV2Id, axisRangeMax and axisCoefficient in its
 * performance record, from Sparklink's switch catalog.
 */
export const axisList = () => packet([Group.GLOBAL, GlobalCmd.AXIS_LIBRARY, CRW.LIST]);

/** `[count, codes...]` lists (profiles, report rates) start at byte 3. */
export function parseList(d: Uint8Array): number[] {
  return Array.from(d.subarray(4, 4 + d[3]));
}

// ------------------------------------------------------------ keycodes

export const SL_NONE = 0x0000;
export const SL_TRANSPARENT = 0x0001;
/** 0xF101..0xF103: Fn1..Fn3. */
export const SL_FN_BASE = 0xf100;
/** 0x2xxx: consumer usage xxx. */
export const SL_CONSUMER = 0x2000;
/** Mouse buttons, high byte 0x41.. (left, right, middle, forward, back). */
export const SL_MOUSE: Readonly<Record<number, number>> = {
  0x4100: 1,
  0x4200: 2,
  0x4300: 3,
  0x4400: 5,
  0x4500: 4
};

// ------------------------------------------------------------ lighting

/** Light areas: 0 the keys, 1.. decorative strips; each with its LED grid. */
export const lightAreas = () => packet([Group.GLOBAL, GlobalCmd.LIGHT_AREAS, 0]);
export type SlLightArea = { index: number; count: number; rows: number; cols: number };
export function parseLightAreas(d: Uint8Array): SlLightArea[] {
  const n = Math.min(d[3], 14);
  return Array.from({ length: n }, (_, i) => ({
    index: d[4 + i * 4],
    count: d[5 + i * 4],
    rows: d[6 + i * 4],
    cols: d[7 + i * 4]
  }));
}
/** Key lighting on two LED rows (upper and lower) switched separately. */
export const doubleLighting = () => packet([Group.GLOBAL, GlobalCmd.DOUBLE_LIGHTING, 0]);

export const LightCmd = { READ: 0x01, WRITE: 0x02, CELLS_READ: 0x03, CELLS_WRITE: 0x04 } as const;
export const LightConfig = { BASE: 0x00, PALETTE: 0x01 } as const;
/** Brightness and speed run 0..100 (confirmed on an SU66 Max by device-hub). */
export const LIGHT_MAX = 100;
/** `open` on keys with two LED rows: 1 lower only, 2 upper only, 3 both. */
export const LIGHT_OPEN_BOTH = 3;

export type SlLightBase = {
  open: number;
  /** 0 static, 1..15 effects, 16 per-key colours, 17..19 reactive. */
  mode: number;
  brightness: number;
  speed: number;
  direction: number;
  /** Palette slot; 0 is the firmware's rainbow. */
  colorSlot: number;
};

export const getLightBase = (area: number) =>
  packet([Group.LIGHTING, LightCmd.READ, area, LightConfig.BASE]);
export const parseLightBase = (d: Uint8Array): SlLightBase => ({
  open: d[4],
  mode: d[5],
  brightness: d[6],
  speed: d[7],
  direction: d[8],
  colorSlot: d[9]
});
export const setLightBase = (area: number, b: SlLightBase) =>
  packet([
    Group.LIGHTING,
    LightCmd.WRITE,
    area,
    LightConfig.BASE,
    b.open,
    b.mode,
    Math.min(b.brightness, LIGHT_MAX),
    Math.min(b.speed, LIGHT_MAX),
    b.direction ? 1 : 0,
    b.colorSlot & 7
  ]);

/** Eight palette colours, B G R and a fourth byte kept as read. */
export const getPalette = (area: number) =>
  packet([Group.LIGHTING, LightCmd.READ, area, LightConfig.PALETTE]);
export const parsePalette = (d: Uint8Array): number[][] =>
  Array.from({ length: 8 }, (_, i) => Array.from(d.subarray(4 + i * 4, 8 + i * 4)));
export const setPalette = (area: number, colors: readonly number[][]) =>
  packet([Group.LIGHTING, LightCmd.WRITE, area, LightConfig.PALETTE, ...colors.flat()]);

/**
 * Per-key colours: the area's LED grid in chunks of 15 cells, each B G R and
 * a flag. 0xFF marks a painted cell; in mode 16 only painted cells light, in
 * any other effect they sit on top of it. Reads return the colour each cell
 * shows now, so only the flag says whether it is painted. Writes are kept.
 */
export const LIGHT_CELLS_PER_CHUNK = 15;
export const LIGHT_PAINTED = 0xff;
export const LIGHT_PER_KEY_MODE = 16;
export const getLightCells = (area: number, chunk: number) =>
  packet([Group.LIGHTING, LightCmd.CELLS_READ, area, chunk]);
export const parseLightCells = (d: Uint8Array): number[][] =>
  Array.from({ length: LIGHT_CELLS_PER_CHUNK }, (_, i) =>
    Array.from(d.subarray(4 + i * 4, 8 + i * 4))
  );
export const setLightCells = (area: number, chunk: number, cells: readonly number[][]) =>
  packet([Group.LIGHTING, LightCmd.CELLS_WRITE, area, chunk, ...cells.flat()]);

// ------------------------------------------------------------ advanced keys

/** Advanced-key modes (protocol-keyboard-v2 HigherKeyMode). */
export const HK = {
  NONE: 0x00,
  DKS: 0x01,
  MPT: 0x02,
  MT: 0x03,
  TGL: 0x04,
  END: 0x05,
  SOCD: 0x06,
  RS: 0x07,
  MDS: 0x08,
  TURBO: 0x09,
  SOCD_V2: 0x0a,
  SOCD4: 0x0f
} as const;
export const HK_READ = 0x01;
export const HK_WRITE = 0x02;
/** SOCD rule as the first key of the pair sees it: 0 last wins, 1 it wins, 2 the other wins, 3 neither. */
export const SOCD_RULE = { LAST: 0, MINE: 1, OTHER: 2, NEUTRAL: 3 } as const;

/** One key's advanced-key record. Reading with mode NONE returns whatever is set. */
export const getHigherKey = (row: number, col: number) =>
  packet([Group.HIGHER_KEY, HK_READ, row, col, HK.NONE]);
export const clearHigherKey = (row: number, col: number) =>
  packet([Group.HIGHER_KEY, HK_WRITE, row, col, HK.NONE]);

export type SlHigherKey =
  | { mode: typeof HK.NONE }
  | { mode: typeof HK.MT; codes: [number, number]; timeMs: number }
  | { mode: typeof HK.TGL; code: number; timeMs: number }
  | {
      mode: typeof HK.DKS;
      codes: [number, number, number, number];
      /** Per keycode, the trps bitmask (see `DKS_BIT`). */
      trps: [number, number, number, number];
      /** First point and bottom-out point, µm. */
      pressUm: number;
      bottomUm: number;
    }
  | {
      mode: typeof HK.SOCD;
      partner: { row: number; col: number };
      codes: [number, number];
      delayMs: number;
      rule: number;
    }
  /** Anything OpenHE does not edit (MPT, END, RS, MDS, Turbo, newer SOCD). */
  | { mode: number; other: true };

export function parseHigherKey(d: Uint8Array): SlHigherKey {
  const mode = d[4];
  switch (mode) {
    case HK.NONE:
      return { mode };
    case HK.MT:
      return { mode, codes: [u16(d, 5), u16(d, 7)], timeMs: u16(d, 9) };
    case HK.TGL:
      return { mode, code: u16(d, 5), timeMs: u16(d, 7) };
    case HK.DKS:
      return {
        mode,
        codes: [u16(d, 5), u16(d, 7), u16(d, 9), u16(d, 11)],
        trps: [d[13], d[14], d[15], d[16]],
        pressUm: u16(d, 17),
        bottomUm: u16(d, 19)
      };
    case HK.SOCD:
      return {
        mode,
        partner: { row: d[5], col: d[6] },
        codes: [u16(d, 7), u16(d, 9)],
        delayMs: u16(d, 11),
        rule: d[13]
      };
    default:
      return { mode, other: true };
  }
}

export const setMt = (row: number, col: number, codes: [number, number], timeMs: number) =>
  packet([
    Group.HIGHER_KEY,
    HK_WRITE,
    row,
    col,
    HK.MT,
    ...le16(codes[0]),
    ...le16(codes[1]),
    ...le16(timeMs)
  ]);

export const setTgl = (row: number, col: number, code: number, timeMs: number) =>
  packet([Group.HIGHER_KEY, HK_WRITE, row, col, HK.TGL, ...le16(code), ...le16(timeMs)]);

/**
 * DKS trps byte, one per keycode. The stroke has four points: past the first
 * point, bottom-out, release from bottom-out (the same depth, going up) and
 * back past the first point. Low nibble is the way down, high nibble the way
 * up (keyboard-docs v2 higherKey). An event bit taps the key at that point; a
 * segment bit keeps it held from one point to the next. Bottom-out is held
 * with both its halves set, as the vendor app does.
 */
export const DKS_BIT = {
  TAP: [0x01, 0x04, 0x20, 0x80],
  /** Held from point i to point i + 1. */
  HOLD: [0x02, 0x08 | 0x10, 0x40]
} as const;

export const setDks = (
  row: number,
  col: number,
  codes: readonly number[],
  trps: readonly number[],
  pressUm: number,
  bottomUm: number
) =>
  packet([
    Group.HIGHER_KEY,
    HK_WRITE,
    row,
    col,
    HK.DKS,
    ...[0, 1, 2, 3].flatMap(i => le16(codes[i] ?? 0)),
    ...[0, 1, 2, 3].map(i => trps[i] ?? 0),
    ...le16(pressUm),
    ...le16(bottomUm)
  ]);

/** Both keys of a SOCD pair, each carrying the other; the rule mirrors for the second key. */
export function setSocdPair(
  a: { row: number; col: number; code: number },
  b: { row: number; col: number; code: number },
  rule: number,
  delayMs: number
): [Uint8Array, Uint8Array] {
  const mirror =
    rule === SOCD_RULE.MINE ? SOCD_RULE.OTHER : rule === SOCD_RULE.OTHER ? SOCD_RULE.MINE : rule;
  const one = (me: typeof a, other: typeof a, r: number) =>
    packet([
      Group.HIGHER_KEY,
      HK_WRITE,
      me.row,
      me.col,
      HK.SOCD,
      other.row,
      other.col,
      ...le16(me.code),
      ...le16(other.code),
      ...le16(delayMs),
      r
    ]);
  return [one(a, b, rule), one(b, a, mirror)];
}

// ------------------------------------------------------------ macros

export const MacroCmd = { GET_MODE: 0x01, SET_MODE: 0x02, GET: 0x03, SET: 0x04 } as const;
/** Keycode that plays macro slot n: 0xF500 + n. */
export const SL_MACRO_BASE = 0xf500;
export const SL_MACRO_SLOTS = 16;
/** Actions in one macro packet. */
export const MACRO_PAGE = 15;
export const MACRO_MAX_DELAY = 0x7fff;
/**
 * Playback modes: 0 tap runs it N times (a tap meanwhile is ignored),
 * 1 ... a tap restarts it, 2 ... a tap stops it, 3 ... a tap stops it after
 * this run, 4 repeats while held and stops on release, 5 ... finishes the
 * run on release.
 */
export const MacroPlay = {
  ONCE: 0,
  RESTART: 1,
  TAP_STOPS: 2,
  TAP_FINISHES: 3,
  HOLD: 4,
  HOLD_FINISHES: 5
} as const;

export type SlMacroAction = { press: boolean; delayMs: number; code: number };
export type SlMacroHeader = { valid: boolean; actions: number; repeat: number; mode: number };

export const macroSpace = () => packet([Group.GLOBAL, 0x0e, 0x00]);
export const getMacroHeader = (slot: number) => packet([Group.MACRO, MacroCmd.GET_MODE, slot]);
export const setMacroHeader = (slot: number, h: SlMacroHeader) =>
  packet([
    Group.MACRO,
    MacroCmd.SET_MODE,
    slot,
    h.valid ? 1 : 0,
    ...le16(h.actions),
    ...le16(h.repeat),
    h.mode
  ]);

export function parseMacroHeader(d: Uint8Array): SlMacroHeader {
  return { valid: d[3] === 1, actions: u16(d, 4), repeat: u16(d, 6), mode: d[8] };
}

export const getMacroPage = (slot: number, page: number) =>
  packet([Group.MACRO, MacroCmd.GET, slot, page]);

/** One action: bit 31 pressed, bits 16..30 delay (ms), bits 0..15 keycode; little-endian. */
const actionBytes = (a: SlMacroAction) => {
  const v =
    ((a.press ? 1 : 0) * 0x80000000 +
      (Math.min(a.delayMs, MACRO_MAX_DELAY) << 16) +
      (a.code & 0xffff)) >>>
    0;
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
};

export const setMacroPage = (slot: number, page: number, actions: readonly SlMacroAction[]) =>
  packet([
    Group.MACRO,
    MacroCmd.SET,
    slot,
    page,
    ...actions.slice(0, MACRO_PAGE).flatMap(actionBytes)
  ]);

export function parseMacroPage(d: Uint8Array): SlMacroAction[] {
  const out: SlMacroAction[] = [];
  for (let i = 0; i < MACRO_PAGE; i++) {
    const v =
      (d[4 + i * 4] | (d[5 + i * 4] << 8) | (d[6 + i * 4] << 16) | (d[7 + i * 4] << 24)) >>> 0;
    out.push({ press: v >>> 31 === 1, delayMs: (v >>> 16) & 0x7fff, code: v & 0xffff });
  }
  return out;
}
