/**
 * Sparklink 16-bit keycodes <-> UI keycodes.
 *
 *   0x0004..0x00E7   HID keyboard usage (modifiers 0xE0..0xE7 included)
 *   0x2xxx           consumer usage xxx
 *   0x4100..0x4500   mouse left, right, middle, forward, back
 *   0xF101..0xF103   Fn1..Fn3 (layer while held)
 *
 * Everything else (transparent, lighting, profile, wireless, gamepad, macro
 * keys ...) is kept as a driver-native code, labelled from the vendor's own
 * key names, so it survives a read-modify-write.
 */

import {
  decodeUiKeycode,
  uiConsumer,
  uiHid,
  uiMomentaryLayer,
  uiMouseButton,
  uiNative,
  type UiKeycode
} from '../keycodes';
import { SL_KEYCODE_NAMES } from './keycodeNames';
import { SL_CONSUMER, SL_FN_BASE, SL_MOUSE } from './protocol';

const MOUSE_TO_UI = SL_MOUSE;
const UI_TO_MOUSE: Record<number, number> = Object.fromEntries(
  Object.entries(SL_MOUSE).map(([code, button]) => [button, Number(code)])
);

export function slToUi(code: number): UiKeycode {
  if (code === 0) return 0;
  if (code >= 0x04 && code <= 0xe7) return uiHid(code);
  if ((code & 0xf000) === SL_CONSUMER) return uiConsumer(code & 0xfff);
  if (MOUSE_TO_UI[code]) return uiMouseButton(MOUSE_TO_UI[code]);
  if (code > SL_FN_BASE && code <= SL_FN_BASE + 3) return uiMomentaryLayer(code - SL_FN_BASE);
  return uiNative(code);
}

export function uiToSl(value: UiKeycode): number | null {
  const d = decodeUiKeycode(value);
  switch (d.type) {
    case 'none':
      return 0;
    case 'hid':
      return d.usage >= 0x04 && d.usage <= 0xe7 ? d.usage : null;
    case 'consumer':
      return SL_CONSUMER | (d.usage & 0xfff);
    case 'mouse':
      return UI_TO_MOUSE[d.button] ?? null;
    case 'layer':
      return d.layer >= 1 && d.layer <= 3 ? SL_FN_BASE + d.layer : null;
    case 'native':
      return d.code <= 0xffff ? d.code : null;
    default:
      return null;
  }
}

/** The vendor driver's legend for a keycode, or null. */
export function slName(code: number): string | null {
  return SL_KEYCODE_NAMES[code]?.[0] ?? null;
}

/** Board-specific keys a picker can offer (Fn layers, lighting, profiles ...). */
export function slExtraKeycodes(): Array<{ value: UiKeycode; label: string }> {
  const out: Array<{ value: UiKeycode; label: string }> = [];
  for (const [codeStr, [name, group]] of Object.entries(SL_KEYCODE_NAMES)) {
    const code = Number(codeStr);
    if (group === 'basic' || group === 'media' || group === 'mouse' || code === 0) continue;
    // gamepad codes only mean something with the board in gamepad mode; macro keys need macros
    if (group === 'game' || group === 'macro') continue;
    out.push({ value: slToUi(code), label: name });
  }
  return out;
}
