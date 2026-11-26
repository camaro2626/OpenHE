/**
 * OpenHE firmware raw HID protocol (gk68tmr_firmware, include/commands.h):
 * libhmk's command set with OpenHE's actuation model. Not hmkconf-compatible.
 *
 * 64-byte output reports on usage page 0xFF48 usage 0x45, report ID 0. Every
 * request gets one 64-byte input report; byte 0 echoes the command ID, or is
 * 0xFF (COMMAND_UNKNOWN) when the board rejected it. All integers are
 * little-endian, all structs packed.
 */

import type { AdvancedKey, DksAction, MacroMode, MacroStep } from '../types';
import { hmkToUi, uiToHmk } from './keycodes';

export const HMK_USAGE_PAGE = 0xff48;
export const HMK_USAGE = 0x45;
export const HMK_REPORT_SIZE = 64;

export const Cmd = {
  FIRMWARE_VERSION: 0,
  REBOOT: 1,
  BOOTLOADER: 2,
  FACTORY_RESET: 3,
  RECALIBRATE: 4,
  ANALOG_INFO: 5,
  GET_CALIBRATION: 6,
  SET_CALIBRATION: 7,
  GET_PROFILE: 8,
  GET_OPTIONS: 9,
  SET_OPTIONS: 10,
  RESET_PROFILE: 11,
  DUPLICATE_PROFILE: 12,
  GET_METADATA: 13,
  GET_SERIAL: 14,
  SAVE_CALIBRATION_THRESHOLD: 15,
  FIRMWARE_INFO: 16,
  GET_SWITCH_PROFILES: 17,
  SET_SWITCH_PROFILES: 18,
  GET_KEY_SWITCHES: 19,
  SET_KEY_SWITCHES: 20,
  /** Calibration session: 0 state, 1 start, 2 finish (Feature.GUIDED_CALIBRATION). */
  CALIBRATION: 21,
  /** Stored crosstalk table, pages of XTALK_CHUNK pairs (Feature.XTALK). */
  GET_XTALK: 22,
  SET_XTALK: 23,
  /** Key LED guide: on, red key (0xFF none), green bits (Feature.KEY_LEDS). */
  KEY_LEDS: 24,
  GET_KEYMAP: 128,
  SET_KEYMAP: 129,
  GET_ACTUATION_MAP: 130,
  SET_ACTUATION_MAP: 131,
  GET_ADVANCED_KEYS: 132,
  SET_ADVANCED_KEYS: 133,
  GET_TICK_RATE: 134,
  SET_TICK_RATE: 135,
  GET_GAMEPAD_BUTTONS: 136,
  SET_GAMEPAD_BUTTONS: 137,
  GET_GAMEPAD_OPTIONS: 138,
  SET_GAMEPAD_OPTIONS: 139,
  GET_MACROS: 140,
  SET_MACROS: 141,
  UNKNOWN: 255
} as const;

/** Per-packet chunk sizes fixed by the command structs. */
export const KEYMAP_CHUNK = 59; // SET; GET returns up to 63
export const KEYMAP_GET_CHUNK = 63;
export const ACTUATION_CHUNK = 6;
export const ANALOG_INFO_CHUNK = 15;
export const STAGED_SET_CHUNK = 59;
export const STAGED_GET_CHUNK = 62;
export const METADATA_CHUNK = 59;

export const ACTUATION_SIZE = 9;

/** COMMAND_FIRMWARE_INFO signature, "OPHE" little-endian. */
export const OPENHE_SIGNATURE = 0x4548504f;
export const OPENHE_PROTOCOL_VERSION = 1;
export const Feature = {
  DEADZONE: 1,
  CONTINUOUS_RT: 2,
  GAMEPAD: 4,
  WIRELESS: 8,
  SWITCH_PROFILES: 16,
  GUIDED_CALIBRATION: 32,
  XTALK: 64,
  KEY_LEDS: 128
} as const;

export const XTALK_CHUNK = 20;
export const XTALK_SLOTS = 96;
/** Coefficients are stored as k * 4096 in one byte. */
export const XTALK_Q = 4096;
export const XTALK_MAX_Q = 255;
export const KEY_LEDS_NONE = 0xff;

export const CalibrationOp = { STATE: 0, START: 1, FINISH: 2 } as const;

/** switch_profile_t: catalog id, travel (0.01 mm), curve. */
export type HmkSwitchProfile = { catalogId: number; travelCmm: number; curve: number };
export const SWITCH_PROFILE_SIZE = 4;
export const KEY_SWITCH_GET_CHUNK = 63;
export const KEY_SWITCH_SET_CHUNK = 60;

export type FirmwareInfo = {
  protocolVersion: number;
  firmwareVersion: number;
  /** Full travel, 0.01 mm */
  travelCmm: number;
  features: number;
};

/** null when the board is not running OpenHE firmware. */
export function decodeFirmwareInfo(r: Uint8Array): FirmwareInfo | null {
  if (rd32(r, 1) !== OPENHE_SIGNATURE) return null;
  return {
    protocolVersion: rd16(r, 5),
    firmwareVersion: rd16(r, 7),
    travelCmm: rd16(r, 9),
    features: rd32(r, 11)
  };
}
export const MACRO_NODE_SIZE = 4;
export const MACRO_NODE_NONE = 0xff;
export const MACRO_MODES: readonly MacroMode[] = ['once', 'repeat', 'hold', 'toggle'];
const MACRO_ACTIONS: ReadonlyArray<MacroStep['action'] | null> = [null, 'press', 'tap', 'release'];
/** macro_node_t delay is 13 bits. */
export const MACRO_MAX_DELAY_MS = 8191;

/** macro_node_t: keycode, action:3 | delay:13 (LE), next. */
export function decodeMacroNode(b: Uint8Array, o: number) {
  const bits = b[o + 1] | (b[o + 2] << 8);
  return {
    keycode: b[o],
    action: MACRO_ACTIONS[bits & 7] ?? null,
    delayMs: bits >> 3,
    next: b[o + 3]
  };
}

export function encodeMacroNode(
  keycode: number,
  action: MacroStep['action'],
  delayMs: number,
  next: number
) {
  const bits =
    (MACRO_ACTIONS.indexOf(action) & 7) |
    (Math.min(MACRO_MAX_DELAY_MS, Math.max(0, Math.round(delayMs))) << 3);
  return [keycode & 0xff, bits & 0xff, (bits >> 8) & 0xff, next & 0xff];
}

/** Board metadata, the gzipped JSON from COMMAND_GET_METADATA (scripts/metadata.py). */
export type HmkMetadata = {
  name: string;
  vendorId: string;
  productId: string;
  usbHighSpeed?: boolean;
  adcResolution: number;
  numProfiles: number;
  numLayers: number;
  numKeys: number;
  numAdvancedKeys: number;
  numDynamicKeystrokeMaxBindings: number;
  numMacroNodes: number;
  layout: { keymap: Array<Array<{ key: number; w?: number; h?: number; x?: number; y?: number }>> };
  defaultKeymaps?: string[][][];
};

export function request(command: number, payload: ArrayLike<number> = []): Uint8Array {
  if (payload.length > HMK_REPORT_SIZE - 1) throw new RangeError('payload too long');
  const out = new Uint8Array(HMK_REPORT_SIZE);
  out[0] = command;
  out.set(payload, 1);
  return out;
}

export const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
export const u32 = (v: number) => [
  v & 0xff,
  (v >>> 8) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 24) & 0xff
];
export const rd16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
export const rd32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// ---------------------------------------------------------------- actuation

export const ActFlag = { RT: 0x01, SPLIT: 0x02, CONTINUOUS: 0x04, DEADZONE: 0x08 } as const;

/** actuation_t: all distances in 0.01 mm. */
export type HmkActuation = {
  actuation: number;
  rtPress: number;
  rtRelease: number;
  topDeadzone: number;
  bottomDeadzone: number;
  flags: number;
};

export function decodeActuation(b: Uint8Array, o: number): HmkActuation {
  return {
    actuation: rd16(b, o),
    rtPress: rd16(b, o + 2),
    rtRelease: rd16(b, o + 4),
    topDeadzone: b[o + 6],
    bottomDeadzone: b[o + 7],
    flags: b[o + 8]
  };
}

export function encodeActuation(a: HmkActuation): number[] {
  return [
    ...u16(a.actuation),
    ...u16(a.rtPress),
    ...u16(a.rtRelease),
    a.topDeadzone & 0xff,
    a.bottomDeadzone & 0xff,
    a.flags & 0xff
  ];
}

// ------------------------------------------------------------ advanced keys

export const AK_TYPE = {
  NONE: 0,
  NULL_BIND: 1,
  DYNAMIC_KEYSTROKE: 2,
  TAP_HOLD: 3,
  TOGGLE: 4,
  MACRO: 5
} as const;
const NB_BEHAVIORS = ['last', 'primary', 'secondary', 'neutral', 'distance'] as const;
const DKS_ACTIONS: readonly DksAction[] = ['hold', 'press', 'release', 'tap'];

/** sizeof(advanced_key_t): layer, key, type + the largest union member. */
export function advancedKeySize(dksBindings: number): number {
  return 3 + Math.max(3, 2 * dksBindings + 1, 5, 3, 1);
}

export function decodeAdvancedKey(
  b: Uint8Array,
  o: number,
  dksBindings: number,
  toMm: (units: number) => number
): AdvancedKey | null {
  const layer = b[o];
  const key = b[o + 1];
  const p = o + 3;
  switch (b[o + 2]) {
    case AK_TYPE.NULL_BIND:
      return {
        kind: 'nullBind',
        layer,
        key,
        secondaryKey: b[p],
        behavior: NB_BEHAVIORS[b[p + 1]] ?? 'last',
        bottomOutMm: toMm(b[p + 2])
      };
    case AK_TYPE.DYNAMIC_KEYSTROKE: {
      const keycodes = [];
      const actions: Array<[DksAction, DksAction, DksAction, DksAction]> = [];
      for (let i = 0; i < dksBindings; i++) {
        keycodes.push(hmkToUi(b[p + i]));
        const m = b[p + dksBindings + i];
        actions.push(
          [0, 2, 4, 6].map(s => DKS_ACTIONS[(m >> s) & 3]) as [
            DksAction,
            DksAction,
            DksAction,
            DksAction
          ]
        );
      }
      return {
        kind: 'dynamicKeystroke',
        layer,
        key,
        keycodes,
        actions,
        bottomOutMm: toMm(b[p + 2 * dksBindings])
      };
    }
    case AK_TYPE.TAP_HOLD:
      return {
        kind: 'tapHold',
        layer,
        key,
        tap: hmkToUi(b[p]),
        hold: hmkToUi(b[p + 1]),
        tappingTermMs: rd16(b, p + 2),
        holdOnOtherKeyPress: b[p + 4] !== 0
      };
    case AK_TYPE.TOGGLE:
      return { kind: 'toggle', layer, key, keycode: hmkToUi(b[p]), tappingTermMs: rd16(b, p + 1) };
    case AK_TYPE.MACRO:
      return {
        kind: 'macro',
        layer,
        key,
        // steps are filled in by the driver from the macro node table
        steps: [],
        mode: MACRO_MODES[b[p + 1]] ?? 'once',
        repeat: b[p + 2] || 1,
        head: b[p]
      } as AdvancedKey & { head: number };
    default:
      return null;
  }
}

function keycodeOrThrow(value: number): number {
  const code = uiToHmk(value);
  if (code === null)
    throw new RangeError(`keycode 0x${value.toString(16)} is not supported by OpenHE firmware`);
  return code;
}

export function encodeAdvancedKey(
  ak: AdvancedKey | null,
  dksBindings: number,
  toUnits: (mm: number) => number
): Uint8Array {
  const out = new Uint8Array(advancedKeySize(dksBindings));
  if (!ak) return out;
  out[0] = ak.layer;
  out[1] = ak.key;
  const p = 3;
  switch (ak.kind) {
    case 'nullBind':
      out[2] = AK_TYPE.NULL_BIND;
      out[p] = ak.secondaryKey;
      out[p + 1] = Math.max(0, NB_BEHAVIORS.indexOf(ak.behavior));
      out[p + 2] = toUnits(ak.bottomOutMm);
      break;
    case 'dynamicKeystroke':
      out[2] = AK_TYPE.DYNAMIC_KEYSTROKE;
      if (ak.keycodes.length > dksBindings)
        throw new RangeError(`at most ${dksBindings} keystrokes`);
      ak.keycodes.forEach((kc, i) => {
        out[p + i] = keycodeOrThrow(kc);
        const a = ak.actions[i] ?? ['hold', 'hold', 'hold', 'hold'];
        out[p + dksBindings + i] = a.reduce(
          (m, act, j) => m | (DKS_ACTIONS.indexOf(act) << (2 * j)),
          0
        );
      });
      out[p + 2 * dksBindings] = toUnits(ak.bottomOutMm);
      break;
    case 'tapHold':
      out[2] = AK_TYPE.TAP_HOLD;
      out[p] = keycodeOrThrow(ak.tap);
      out[p + 1] = keycodeOrThrow(ak.hold);
      out.set(u16(ak.tappingTermMs), p + 2);
      out[p + 4] = ak.holdOnOtherKeyPress ? 1 : 0;
      break;
    case 'toggle':
      out[2] = AK_TYPE.TOGGLE;
      out[p] = keycodeOrThrow(ak.keycode);
      out.set(u16(ak.tappingTermMs), p + 1);
      break;
    case 'macro':
      // the driver places the steps in the node table and passes the head
      out[2] = AK_TYPE.MACRO;
      out[p] = (ak as AdvancedKey & { head?: number }).head ?? MACRO_NODE_NONE;
      out[p + 1] = Math.max(0, MACRO_MODES.indexOf(ak.mode));
      out[p + 2] = Math.min(255, Math.max(1, Math.round(ak.repeat || 1)));
      break;
  }
  return out;
}

// ----------------------------------------------------------------- metadata

export async function gunzipJson<T>(bytes: Uint8Array): Promise<T> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}

export function formatFirmwareVersion(v: number): string {
  return `${(v >> 8) & 0xff}.${v & 0xff}`;
}
