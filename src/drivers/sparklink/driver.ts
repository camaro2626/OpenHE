/**
 * Sparklink (星闪悦动) magnetic keyboards, protocol v2 (usage page 0xFFB0).
 *
 * The board describes itself: device info, feature bits, and the key layout
 * (rows of up to 21 keys, each with a position and width). Settings belong to
 * the active profile ("config"), so reads and writes switch to it first.
 * Writes are followed by the protocol's save for that area.
 */

import {
  hasCollection,
  InputReportTransport,
  type HidDeviceLike,
  type ReportTransport
} from '../transport';
import {
  DriverError,
  type BoardLayout,
  type DeviceInfo,
  type DeviceOptions,
  type DriverCapabilities,
  type AdvancedKey,
  type KeyActuation,
  type MacroStep,
  type KeyboardDriver,
  type LayoutKey,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { decodeUiKeycode, uiNative } from '../keycodes';
import { isSparklinkId, SPARKLINK_IDS } from './ids';
import { slExtraKeycodes, slName, slToUi, uiToSl } from './keycodes';
import {
  Area,
  configList,
  configRead,
  configWrite,
  DeviceCmd,
  factoryReset,
  getDefaultRow,
  getKeyRow,
  getPerformance,
  getRoute,
  getStyleRow,
  Group,
  KEY_WIDTH,
  packet,
  parseAxisRow,
  parseDeviceInfo,
  parseFeatures,
  parseKeycodeRow,
  parseList,
  parsePerformance,
  parseStyleRow,
  rateList,
  rateRead,
  rateWrite,
  REPORT_RATES_HZ,
  rtPrecision,
  save,
  setKeyRow,
  setPerformance,
  SL_LAYERS,
  SL_TRANSPARENT,
  SL_MAX_ROWS,
  SL_USAGE,
  SL_USAGE_PAGE,
  TriggerMode,
  clearHigherKey,
  getHigherKey,
  HK,
  parseHigherKey,
  setMt,
  setSocdPair,
  setTgl,
  SOCD_RULE,
  type SlHigherKey,
  getMacroHeader,
  getMacroPage,
  MACRO_PAGE,
  MacroPlay,
  macroSpace,
  parseMacroHeader,
  parseMacroPage,
  setMacroHeader,
  setMacroPage,
  SL_MACRO_BASE,
  SL_MACRO_SLOTS,
  type SlMacroAction,
  type SlMacroHeader,
  type SlDeviceInfo,
  type SlFeatures,
  type SlPerformance
} from './protocol';

/** One WebHID filter per vendor id on Sparklink's list; the product id is checked on open. */
export const SL_HID_FILTERS = Object.keys(SPARKLINK_IDS).map(vid => ({
  vendorId: Number(vid),
  usagePage: SL_USAGE_PAGE,
  usage: SL_USAGE
}));

/** A Sparklink settings interface on an id Sparklink's own drivers talk to. */
export function isSparklinkDevice(device: HidDeviceLike): boolean {
  return (
    hasCollection(device, SL_USAGE_PAGE, SL_USAGE) &&
    isSparklinkId(device.vendorId, device.productId)
  );
}

const DEFAULT_TRAVEL_MM = 4;
const DEFAULT_STEP_MM = 0.01;
const um = (mm: number) => Math.round(mm * 1000);
const mm = (micro: number) => micro / 1000;

type Position = { row: number; col: number };

export class SparklinkDriver implements KeyboardDriver {
  readonly id = 'sparklink' as const;
  /** 0x0001 passes through; an empty slot (0x0000) does nothing. */
  readonly transparentKeycode = uiNative(SL_TRANSPARENT);
  readonly capabilities: DriverCapabilities;
  private readonly rateCodes: number[];
  /** Raw performance per layout key, for the fields OpenHE does not edit. */
  private perfCache: { profile: number; values: SlPerformance[] } | null = null;
  private readonly rowCache = new Map<string, number[]>();

  private constructor(
    private readonly transport: ReportTransport,
    readonly info: DeviceInfo,
    readonly device: SlDeviceInfo,
    readonly features: SlFeatures,
    readonly layout: BoardLayout,
    /** Row and column of each layout key. */
    private readonly positions: Position[],
    private readonly defaults: UiKeycode[] | null,
    profiles: number,
    rateCodes: number[],
    travelMm: number,
    stepMm: number
  ) {
    this.rateCodes = rateCodes;
    this.capabilities = {
      profiles,
      layers: SL_LAYERS,
      travelMm,
      travelStepMm: stepMm,
      actuation: true,
      rapidTrigger: true,
      rapidTriggerSplit: true,
      continuousRapidTrigger: true,
      advancedKeys: ['nullBind', 'tapHold', 'toggle', 'macro'],
      maxAdvancedKeys: layout.keys.length,
      advancedKeyLimits: {
        baseLayerOnly: ['nullBind', 'tapHold', 'toggle'],
        nullBindBehaviors: ['last', 'primary', 'secondary', 'neutral'],
        nullBindBottomOut: false,
        tapHoldTermMs: { min: 50, max: 2000, step: 10 },
        holdOnOtherKeyPress: false
      },
      dynamicKeystrokeBindings: 0,
      macros: true,
      travelStream: true,
      calibration: false,
      rgb: false,
      gamepad: false,
      pollingRates: rateCodes.map(c => REPORT_RATES_HZ[c]).filter(Boolean),
      releasePoint: true,
      topDeadzone: true,
      bottomDeadzone: true,
      writable: { keymap: true, actuation: true, advancedKeys: true },
      actuationActiveProfileOnly: true
    };
  }

  /** Open the device's settings interface and read what the board says about itself. */
  static async fromHidDevice(device: HidDeviceLike): Promise<SparklinkDriver> {
    if (!isSparklinkDevice(device))
      throw new DriverError('This device is not on the list of Sparklink keyboards.');
    if (!device.opened) await device.open();
    const transport = new InputReportTransport(device, 0);
    try {
      return await SparklinkDriver.connect(transport, {
        vendorId: device.vendorId,
        productId: device.productId,
        productName: device.productName
      });
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err;
    }
  }

  static async connect(
    transport: ReportTransport,
    usb: { vendorId: number; productId: number; productName: string }
  ): Promise<SparklinkDriver> {
    const ask = (pkt: Uint8Array, timeoutMs = 1000) => call(transport, pkt, timeoutMs);
    const device = parseDeviceInfo(await ask(packet([Group.DEVICE, DeviceCmd.INFO])));
    const features = parseFeatures(await ask(packet([Group.DEVICE, DeviceCmd.FEATURE])));
    if (!features.magnetic && !features.magnetic3d)
      throw new DriverError(
        `${usb.productName || 'This keyboard'} is a Sparklink board without magnetic switches; OpenHE configures magnetic keyboards.`
      );

    // the board's own picture: up to 8 rows of up to 21 keys
    const styles: ReturnType<typeof parseStyleRow>[] = [];
    const base: number[][] = [];
    for (let row = 0; row < SL_MAX_ROWS; row++) {
      styles.push(parseStyleRow(await ask(getStyleRow(row))).map(s => s));
      base.push(parseKeycodeRow(await ask(getKeyRow(0, row))));
    }
    const { layout, positions } = layoutFrom(styles, base);
    if (!positions.length) throw new DriverError('The keyboard reported no keys.');

    const defaults = await readDefaults(ask, positions).catch(() => null);
    const label = (i: number) => {
      const { row, col } = positions[i];
      const code = defaults ? (uiToSl(defaults[i]) ?? base[row][col]) : base[row][col];
      return slName(code) ?? '';
    };
    layout.keys.forEach((k, i) => (k.label = label(i)));

    const profiles = await optional(async () => (await ask(configList()))[3], 1);
    const rateCodes = await optional(async () => parseList(await ask(rateList())), []);
    const stepMm = await optional(async () => {
      const step = (await ask(rtPrecision()))[3] / 1000;
      return step > 0 && step <= 0.1 ? step : DEFAULT_STEP_MM;
    }, DEFAULT_STEP_MM);
    const travelMm = await optional(async () => {
      const first = positions[0];
      const p = parsePerformance(await ask(getPerformance(first.row, first.col)));
      return p.axisRangeMax >= 1000 && p.axisRangeMax <= 6000
        ? mm(p.axisRangeMax)
        : DEFAULT_TRAVEL_MM;
    }, DEFAULT_TRAVEL_MM);

    return new SparklinkDriver(
      transport,
      {
        name: usb.productName || 'Sparklink keyboard',
        firmwareVersion: device.appVersion,
        serial: device.serial || undefined,
        vendorId: usb.vendorId,
        productId: usb.productId
      },
      device,
      features,
      layout,
      positions,
      defaults,
      Math.max(1, Math.min(profiles || 1, 8)),
      rateCodes.filter(c => c < REPORT_RATES_HZ.length),
      travelMm,
      stepMm
    );
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private ask(pkt: Uint8Array, timeoutMs = 1000) {
    return call(this.transport, pkt, timeoutMs);
  }

  private checkProfile(profile: number) {
    if (!Number.isInteger(profile) || profile < 0 || profile >= this.capabilities.profiles)
      throw new RangeError(`profile ${profile} out of range`);
  }

  async getProfile(): Promise<number> {
    return (await this.ask(configRead()))[3];
  }

  async setProfile(profile: number): Promise<void> {
    this.checkProfile(profile);
    await this.ask(configWrite(profile));
    this.perfCache = null;
    this.rowCache.clear();
  }

  private async useProfile(profile: number) {
    this.checkProfile(profile);
    if (this.capabilities.profiles > 1 && (await this.getProfile()) !== profile)
      await this.setProfile(profile);
  }

  private get rows(): number[] {
    return [...new Set(this.positions.map(p => p.row))].sort((a, b) => a - b);
  }

  private async keyRow(layer: number, row: number, fresh = false): Promise<number[]> {
    const key = `${layer}:${row}`;
    const cached = this.rowCache.get(key);
    if (cached && !fresh) return cached;
    const codes = parseKeycodeRow(await this.ask(getKeyRow(layer, row)));
    this.rowCache.set(key, codes);
    return codes;
  }

  // ------------------------------------------------------------ keymap

  async getKeymap(profile: number, layer: number): Promise<UiKeycode[]> {
    this.checkLayer(layer);
    await this.useProfile(profile);
    const rows = new Map<number, number[]>();
    for (const row of this.rows) rows.set(row, await this.keyRow(layer, row, true));
    return this.positions.map(({ row, col }) => slToUi(rows.get(row)![col]));
  }

  async setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void> {
    this.checkLayer(layer);
    if (keymap.length !== this.positions.length)
      throw new RangeError('keymap length does not match the board');
    await this.useProfile(profile);
    const next = new Map<number, number[]>();
    for (const row of this.rows) next.set(row, [...(await this.keyRow(layer, row))]);
    keymap.forEach((value, i) => {
      const code = uiToSl(value);
      if (code === null)
        throw new DriverError(
          `Key ${this.layout.keys[i]?.label || i}: this keycode is not available on this board`
        );
      const { row, col } = this.positions[i];
      next.get(row)![col] = code;
    });
    await this.writeRows(layer, next);
  }

  private checkLayer(layer: number) {
    if (!Number.isInteger(layer) || layer < 0 || layer >= SL_LAYERS)
      throw new RangeError(`layer ${layer} out of range`);
  }

  defaultKeymap(layer = 0): UiKeycode[] | null {
    return layer === 0 ? this.defaults : null;
  }

  supportsKeycode(value: UiKeycode): boolean {
    return uiToSl(value) !== null;
  }

  keycodeLabel(value: UiKeycode): string | null {
    const d = decodeUiKeycode(value);
    if (d.type === 'layer') return `Fn${d.layer}`;
    if (d.type !== 'native') return null;
    if (d.code === SL_TRANSPARENT) return '▽';
    return slName(d.code);
  }

  extraKeycodes(): Array<{ value: UiKeycode; label: string }> {
    return slExtraKeycodes();
  }

  // ------------------------------------------------------------ actuation

  private async readPerformance(profile: number): Promise<SlPerformance[]> {
    if (this.perfCache?.profile === profile) return this.perfCache.values;
    await this.useProfile(profile);
    const values: SlPerformance[] = [];
    for (const { row, col } of this.positions)
      values.push(parsePerformance(await this.ask(getPerformance(row, col))));
    this.perfCache = { profile, values };
    return values;
  }

  async getActuation(profile: number): Promise<KeyActuation[]> {
    this.perfCache = null;
    return (await this.readPerformance(profile)).map(toActuation);
  }

  async setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void> {
    if (actuation.length !== this.positions.length)
      throw new RangeError('actuation length does not match the board');
    const current = await this.readPerformance(profile);
    const next = current.map((p, i) => fromActuation(p, actuation[i]));
    let wrote = false;
    for (let i = 0; i < next.length; i++) {
      if (samePerformance(current[i], next[i])) continue;
      const { row, col } = this.positions[i];
      await this.ask(setPerformance(row, col, next[i]));
      wrote = true;
    }
    if (wrote) await this.ask(save(Area.PERFORMANCE));
    this.perfCache = { profile, values: next };
  }

  // ------------------------------------------------------------ advanced keys

  /** What each layout key has set, read fresh by getAdvancedKeys. */
  private hkCache: { profile: number; values: SlHigherKey[] } | null = null;

  private async readHigherKeys(profile: number): Promise<SlHigherKey[]> {
    if (this.hkCache?.profile === profile) return this.hkCache.values;
    await this.useProfile(profile);
    const values: SlHigherKey[] = [];
    for (const { row, col } of this.positions)
      values.push(parseHigherKey(await this.ask(getHigherKey(row, col))));
    this.hkCache = { profile, values };
    return values;
  }

  /** SOCD, tap-hold (MT) and toggle (TGL); other kinds set elsewhere are left alone. */
  async getAdvancedKeys(profile: number): Promise<AdvancedKey[]> {
    this.hkCache = null;
    const hks = await this.readHigherKeys(profile);
    const out: AdvancedKey[] = await this.getMacros();
    const indexOf = new Map(this.positions.map((p, i) => [`${p.row}:${p.col}`, i]));
    hks.forEach((hk, key) => {
      if ('other' in hk) return;
      if (hk.mode === HK.MT)
        out.push({
          kind: 'tapHold',
          layer: 0,
          key,
          tap: slToUi(hk.codes[MT_TAP]),
          hold: slToUi(hk.codes[1 - MT_TAP]),
          tappingTermMs: hk.timeMs,
          holdOnOtherKeyPress: false
        });
      else if (hk.mode === HK.TGL)
        out.push({
          kind: 'toggle',
          layer: 0,
          key,
          keycode: slToUi(hk.code),
          tappingTermMs: hk.timeMs
        });
      else if (hk.mode === HK.SOCD) {
        const partner = indexOf.get(`${hk.partner.row}:${hk.partner.col}`);
        // one entry per pair, from the first key in layout order
        if (partner !== undefined && partner < key && hks[partner].mode === HK.SOCD) return;
        out.push({
          kind: 'nullBind',
          layer: 0,
          key,
          secondaryKey: partner ?? key,
          behavior: SOCD_BEHAVIOR[hk.rule] ?? 'last',
          bottomOutMm: 0
        });
      }
    });
    return out;
  }

  async setAdvancedKeys(profile: number, all: readonly AdvancedKey[]): Promise<void> {
    await this.useProfile(profile);
    await this.setMacros(all.filter(k => k.kind === 'macro'));
    const keys = all.filter(k => k.kind !== 'macro');
    for (const ak of keys) {
      if (ak.kind === 'dynamicKeystroke')
        throw new DriverError(
          'This board does not take that kind of advanced key from OpenHE yet.'
        );
      if (ak.layer !== 0)
        throw new DriverError('Advanced keys work on the base layer on this board.');
      if (ak.kind === 'nullBind' && ak.behavior === 'distance')
        throw new DriverError('This board’s SOCD has no "deeper press wins" rule.');
    }
    const current = await this.readHigherKeys(profile);
    const base = new Map<number, number[]>();
    for (const row of this.rows) base.set(row, await this.keyRow(0, row));
    const own = (key: number) => {
      const { row, col } = this.positions[key];
      return base.get(row)![col];
    };
    const code = (value: UiKeycode) => {
      const c = uiToSl(value);
      if (c === null)
        throw new DriverError('An advanced key uses a keycode this keyboard cannot store.');
      return c;
    };

    // what every key should hold afterwards
    const next: SlHigherKey[] = current.map(hk => ('other' in hk ? hk : { mode: HK.NONE }));
    for (const ak of keys) {
      if (ak.kind === 'tapHold') {
        const codes: [number, number] = [0, 0];
        codes[MT_TAP] = code(ak.tap);
        codes[1 - MT_TAP] = code(ak.hold);
        next[ak.key] = { mode: HK.MT, codes, timeMs: Math.round(ak.tappingTermMs) };
      } else if (ak.kind === 'toggle') {
        next[ak.key] = {
          mode: HK.TGL,
          code: code(ak.keycode),
          timeMs: Math.round(ak.tappingTermMs)
        };
      } else if (ak.kind === 'nullBind') {
        const was = current[ak.key];
        const delayMs = was.mode === HK.SOCD && 'delayMs' in was ? was.delayMs : 0;
        const rule = SOCD_RULE[RULE_OF[ak.behavior as keyof typeof RULE_OF]];
        const a = this.positions[ak.key];
        const b = this.positions[ak.secondaryKey];
        next[ak.key] = {
          mode: HK.SOCD,
          partner: b,
          codes: [own(ak.key), own(ak.secondaryKey)],
          delayMs,
          rule
        };
        next[ak.secondaryKey] = {
          mode: HK.SOCD,
          partner: a,
          codes: [own(ak.secondaryKey), own(ak.key)],
          delayMs,
          rule:
            rule === SOCD_RULE.MINE
              ? SOCD_RULE.OTHER
              : rule === SOCD_RULE.OTHER
                ? SOCD_RULE.MINE
                : rule
        };
      }
    }

    let wrote = false;
    const done = new Set<number>();
    for (let key = 0; key < next.length; key++) {
      if (done.has(key) || sameHk(current[key], next[key])) continue;
      const { row, col } = this.positions[key];
      const hk = next[key];
      if (hk.mode === HK.NONE) await this.ask(clearHigherKey(row, col));
      else if (hk.mode === HK.MT && 'codes' in hk && !('partner' in hk))
        await this.ask(setMt(row, col, hk.codes, hk.timeMs));
      else if (hk.mode === HK.TGL && 'code' in hk)
        await this.ask(setTgl(row, col, hk.code, hk.timeMs));
      else if (hk.mode === HK.SOCD && 'partner' in hk) {
        const other = this.positions.findIndex(
          p => p.row === hk.partner.row && p.col === hk.partner.col
        );
        const [first, second] = setSocdPair(
          { row, col, code: hk.codes[0] },
          { ...hk.partner, code: hk.codes[1] },
          hk.rule,
          hk.delayMs
        );
        await this.ask(first);
        await this.ask(second);
        done.add(other);
      } else continue;
      wrote = true;
    }
    if (wrote) await this.ask(save(Area.HIGHER_KEY));
    this.hkCache = { profile, values: next };
  }

  // ------------------------------------------------------------ macros

  private readonly macroCache = new Map<
    number,
    { header: SlMacroHeader; actions: SlMacroAction[] }
  >();
  private macroLimit: number | null = null;

  private async macro(slot: number) {
    let m = this.macroCache.get(slot);
    if (!m) {
      const header = parseMacroHeader(await this.ask(getMacroHeader(slot)));
      const actions: SlMacroAction[] = [];
      if (header.valid)
        for (let page = 0; page * MACRO_PAGE < header.actions; page++)
          actions.push(...parseMacroPage(await this.ask(getMacroPage(slot, page))));
      m = { header, actions: actions.slice(0, header.valid ? header.actions : 0) };
      this.macroCache.set(slot, m);
    }
    return m;
  }

  /** Actions one macro can hold: the board's total over its slot count. */
  private async maxActions(): Promise<number> {
    if (this.macroLimit === null)
      this.macroLimit = await optional(async () => {
        const d = await this.ask(macroSpace());
        const count = d[3] || SL_MACRO_SLOTS;
        const total = d[4] | (d[5] << 8);
        return total ? Math.floor(total / count) : 60;
      }, 60);
    return this.macroLimit;
  }

  /** Keys playing macro slot n carry 0xF500 + n, on any layer. */
  private async macroKeys(): Promise<Array<{ layer: number; key: number; slot: number }>> {
    const out: Array<{ layer: number; key: number; slot: number }> = [];
    for (let layer = 0; layer < SL_LAYERS; layer++) {
      const rows = new Map<number, number[]>();
      for (const row of this.rows) rows.set(row, await this.keyRow(layer, row, true));
      this.positions.forEach(({ row, col }, key) => {
        const code = rows.get(row)![col];
        if (code >= SL_MACRO_BASE && code < SL_MACRO_BASE + SL_MACRO_SLOTS)
          out.push({ layer, key, slot: code - SL_MACRO_BASE });
      });
    }
    return out;
  }

  private async getMacros(): Promise<AdvancedKey[]> {
    this.macroCache.clear();
    const out: AdvancedKey[] = [];
    for (const { layer, key, slot } of await this.macroKeys()) {
      const { header, actions } = await this.macro(slot);
      out.push({
        kind: 'macro',
        layer,
        key,
        steps: actions.map(a => ({
          keycode: slToUi(a.code),
          action: a.press ? 'press' : 'release',
          delayMs: a.delayMs
        })),
        mode:
          header.mode === MacroPlay.HOLD || header.mode === MacroPlay.HOLD_FINISHES
            ? 'hold'
            : header.mode === MacroPlay.TAP_STOPS
              ? 'toggle'
              : header.repeat > 1
                ? 'repeat'
                : 'once',
        repeat: Math.max(1, Math.min(header.repeat, 255)),
        slMacroSlot: slot
      } as AdvancedKey);
    }
    return out;
  }

  private async setMacros(keys: readonly AdvancedKey[]): Promise<void> {
    const macros = keys as ReadonlyArray<
      Extract<AdvancedKey, { kind: 'macro' }> & { slMacroSlot?: number }
    >;
    const mine = await this.macroKeys();
    const limit = await this.maxActions();
    const wanted = macros.map(ak => {
      const actions = stepsToActions(ak.steps);
      if (actions.length > limit)
        throw new DriverError(
          `A macro on this keyboard holds at most ${limit} presses and releases.`
        );
      const header: SlMacroHeader = {
        valid: true,
        actions: actions.length,
        ...(ak.mode === 'hold'
          ? { mode: MacroPlay.HOLD, repeat: 1 }
          : ak.mode === 'toggle'
            ? { mode: MacroPlay.TAP_STOPS, repeat: 0xffff }
            : { mode: MacroPlay.ONCE, repeat: ak.mode === 'repeat' ? Math.max(1, ak.repeat) : 1 })
      };
      return { ak, actions, header, id: macroId(header, actions) };
    });
    if (!wanted.length && !mine.length) return;

    // slots this profile plays are ours; other valid slots may belong to another profile
    const ours = new Set(mine.map(m => m.slot));
    const protectedSlots = new Set<number>();
    for (let slot = 0; slot < SL_MACRO_SLOTS; slot++)
      if (!ours.has(slot) && (await this.macro(slot)).header.valid) protectedSlots.add(slot);
    const content = async (slot: number) => {
      const m = await this.macro(slot);
      return macroId(m.header, m.actions);
    };
    const slotOf = new Map<string, number>();
    const taken = new Set<number>();
    const hints = new Set(
      macros.map(m => m.slMacroSlot).filter((x): x is number => x !== undefined)
    );
    let wrote = false;
    for (const w of wanted) {
      if (slotOf.has(w.id)) continue;
      let slot = -1;
      const hint = w.ak.slMacroSlot;
      if (
        hint !== undefined &&
        !taken.has(hint) &&
        (!protectedSlots.has(hint) || (await content(hint)) === w.id)
      )
        slot = hint;
      if (slot < 0)
        for (let s = 0; s < SL_MACRO_SLOTS && slot < 0; s++)
          if (!taken.has(s) && !protectedSlots.has(s) && !hints.has(s)) slot = s;
      for (let s = 0; s < SL_MACRO_SLOTS && slot < 0; s++)
        if (!taken.has(s) && !protectedSlots.has(s)) slot = s;
      if (slot < 0)
        throw new DriverError(
          `The keyboard holds ${SL_MACRO_SLOTS} macros, and the other profiles use the rest.`
        );
      taken.add(slot);
      slotOf.set(w.id, slot);
      if ((await content(slot)) === w.id) continue;
      const pages = Math.max(1, Math.ceil(w.actions.length / MACRO_PAGE));
      for (let page = 0; page < pages; page++)
        await this.ask(
          setMacroPage(slot, page, w.actions.slice(page * MACRO_PAGE, (page + 1) * MACRO_PAGE))
        );
      await this.ask(setMacroHeader(slot, w.header));
      this.macroCache.set(slot, { header: w.header, actions: w.actions });
      wrote = true;
    }
    if (wrote) await this.ask(save(Area.MACRO));

    // bind the keys; a key that lost its macro goes back to its default (base) or falls through
    for (let layer = 0; layer < SL_LAYERS; layer++) {
      const rows = new Map<number, number[]>();
      for (const row of this.rows) rows.set(row, [...(await this.keyRow(layer, row))]);
      const set = (key: number, code: number) => {
        const { row, col } = this.positions[key];
        rows.get(row)![col] = code;
      };
      for (const m of mine)
        if (m.layer === layer)
          set(m.key, layer === 0 ? (uiToSl(this.defaults?.[m.key] ?? 0) ?? 0) : SL_TRANSPARENT);
      for (const w of wanted)
        if (w.ak.layer === layer) set(w.ak.key, SL_MACRO_BASE + slotOf.get(w.id)!);
      await this.writeRows(layer, rows);
    }
  }

  /** Write the rows that changed, then save the layout. */
  private async writeRows(layer: number, next: Map<number, number[]>): Promise<void> {
    let wrote = false;
    for (const [row, codes] of next) {
      const before = await this.keyRow(layer, row);
      if (codes.every((c, i) => c === before[i])) continue;
      await this.ask(setKeyRow(layer, row, codes));
      this.rowCache.set(`${layer}:${row}`, codes);
      wrote = true;
    }
    if (wrote) await this.ask(save(Area.LAYOUT));
  }

  // ------------------------------------------------------------ live travel

  async readTravel(): Promise<TravelSample[]> {
    const byRow = new Map<number, number[]>();
    for (const row of this.rows) byRow.set(row, parseAxisRow(await this.ask(getRoute(row))));
    return this.positions.map(({ row, col }, index) => {
      const micro = byRow.get(row)![col];
      return { index, raw: micro, travelMm: mm(micro) };
    });
  }

  // ------------------------------------------------------------ device

  async getOptions(): Promise<DeviceOptions> {
    if (!this.rateCodes.length) return {};
    const code = (await this.ask(rateRead()))[3];
    return { pollingRateHz: REPORT_RATES_HZ[code] };
  }

  async setOptions(options: DeviceOptions): Promise<void> {
    if (options.pollingRateHz === undefined) return;
    const code = REPORT_RATES_HZ.indexOf(options.pollingRateHz as (typeof REPORT_RATES_HZ)[number]);
    if (code < 0 || !this.rateCodes.includes(code))
      throw new DriverError(`${options.pollingRateHz} Hz is not offered by this keyboard.`);
    await this.ask(rateWrite(code));
  }

  /** Every profile, keymap and setting back to factory. */
  async factoryReset(): Promise<void> {
    await this.ask(factoryReset(Area.ALL), 3000);
    this.perfCache = null;
    this.rowCache.clear();
  }
}

// ------------------------------------------------------------ helpers

/**
 * Which of MT's two keycodes is the tap. The vendor's docs do not say;
 * tap first, as most vendor apps list it. Unconfirmed on hardware.
 */
const MT_TAP = 0;

const SOCD_BEHAVIOR: Record<number, Extract<AdvancedKey, { kind: 'nullBind' }>['behavior']> = {
  [SOCD_RULE.LAST]: 'last',
  [SOCD_RULE.MINE]: 'primary',
  [SOCD_RULE.OTHER]: 'secondary',
  [SOCD_RULE.NEUTRAL]: 'neutral'
};
const RULE_OF = { last: 'LAST', primary: 'MINE', secondary: 'OTHER', neutral: 'NEUTRAL' } as const;

const sameHk = (a: SlHigherKey, b: SlHigherKey) => JSON.stringify(a) === JSON.stringify(b);

/** A macro's identity, independent of how its objects were built. */
const macroId = (h: SlMacroHeader, actions: readonly SlMacroAction[]) =>
  JSON.stringify([
    h.valid,
    h.actions,
    h.repeat,
    h.mode,
    actions.map(a => [a.press, a.delayMs, a.code])
  ]);

/** Steps as board actions; a tap is a press and a release. */
function stepsToActions(steps: readonly MacroStep[]): SlMacroAction[] {
  const out: SlMacroAction[] = [];
  for (const step of steps) {
    const code = uiToSl(step.keycode);
    if (code === null || code === 0)
      throw new DriverError('A macro step uses a key this keyboard cannot play in a macro.');
    const delayMs = Math.max(0, Math.round(step.delayMs));
    if (step.action === 'tap')
      out.push({ press: true, delayMs: 0, code }, { press: false, delayMs, code });
    else out.push({ press: step.action === 'press', delayMs, code });
  }
  return out;
}

/** One request; the reply must echo the group and sub-command. */
async function call(
  transport: ReportTransport,
  pkt: Uint8Array,
  timeoutMs = 1000
): Promise<Uint8Array> {
  const reply = await transport.exchange(pkt, timeoutMs, r => r[0] === pkt[0] && r[1] === pkt[1]);
  return reply;
}

async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function readDefaults(
  ask: (pkt: Uint8Array) => Promise<Uint8Array>,
  positions: Position[]
): Promise<UiKeycode[]> {
  const rows = new Map<number, number[]>();
  for (const row of new Set(positions.map(p => p.row)))
    rows.set(row, parseKeycodeRow(await ask(getDefaultRow(0, row))));
  const codes = positions.map(({ row, col }) => rows.get(row)![col]);
  if (codes.every(c => c === 0)) throw new Error('no default keymap');
  return codes.map(slToUi);
}

/**
 * Layout from the board's key positions; a board that reports none gets a
 * grid of every slot holding a keycode.
 */
export function layoutFrom(
  styles: ReturnType<typeof parseStyleRow>[],
  base: number[][]
): { layout: BoardLayout; positions: Position[] } {
  const keys: LayoutKey[] = [];
  const positions: Position[] = [];
  const styled = styles.some(row => row.some(s => KEY_WIDTH[s.ratio]));
  styles.forEach((row, r) => {
    row.forEach((s, c) => {
      const present = styled ? KEY_WIDTH[s.ratio] !== undefined : base[r]?.[c] !== 0;
      if (!present) return;
      positions.push({ row: r, col: c });
      keys.push({
        index: keys.length,
        x: styled ? s.col : c,
        y: styled ? s.row : r,
        w: styled ? KEY_WIDTH[s.ratio] : 1,
        h: styled && s.ratio === 10 ? 2 : 1,
        label: ''
      });
    });
  });
  const width = keys.reduce((m, k) => Math.max(m, k.x + k.w), 0);
  const height = keys.reduce((m, k) => Math.max(m, k.y + k.h), 0);
  return { layout: { keys, width, height, source: styled ? 'board' : 'grid' }, positions };
}

function toActuation(p: SlPerformance): KeyActuation {
  const rt = p.mode !== TriggerMode.NORMAL;
  return {
    actuationMm: mm(rt ? p.rtFirstTouch || p.normalPress : p.normalPress),
    rapidTrigger: rt,
    splitSensitivity: p.rtPress !== p.rtRelease,
    rtPressMm: mm(p.rtPress),
    rtReleaseMm: mm(p.rtRelease),
    continuous: p.mode === TriggerMode.RT,
    deadzoneEnabled: p.pressDead > 0 || p.releaseDead > 0,
    topDeadzoneMm: mm(p.pressDead),
    bottomDeadzoneMm: mm(p.releaseDead),
    releaseMm: mm(p.normalRelease)
  };
}

/**
 * The board keeps a plain actuation point and a Rapid Trigger one. OpenHE
 * shows the one the key's mode uses and writes only that, so the other stays
 * as the board had it.
 */
function fromActuation(p: SlPerformance, a: KeyActuation): SlPerformance {
  const point = um(a.actuationMm);
  const mode = !a.rapidTrigger
    ? TriggerMode.NORMAL
    : a.continuous
      ? TriggerMode.RT
      : TriggerMode.INTERVAL_RT;
  return {
    ...p,
    mode,
    normalPress: a.rapidTrigger ? p.normalPress : point,
    rtFirstTouch: a.rapidTrigger ? point : p.rtFirstTouch,
    normalRelease: a.releaseMm !== undefined ? um(a.releaseMm) : p.normalRelease,
    rtPress: um(a.rtPressMm),
    rtRelease: um(a.splitSensitivity ? a.rtReleaseMm : a.rtPressMm),
    pressDead: a.deadzoneEnabled ? um(a.topDeadzoneMm) : 0,
    releaseDead: a.deadzoneEnabled ? um(a.bottomDeadzoneMm) : 0
  };
}

function samePerformance(a: SlPerformance, b: SlPerformance): boolean {
  return (Object.keys(a) as Array<keyof SlPerformance>).every(k => a[k] === b[k]);
}
