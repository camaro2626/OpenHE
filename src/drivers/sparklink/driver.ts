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
  type DksAction,
  type KeyActuation,
  type LightEffect,
  type LightingInfo,
  type LightingState,
  type LightSetting,
  type LightZone,
  type SwitchCatalogEntry,
  type SwitchSetup,
  type MacroStep,
  type KeyboardDriver,
  type LayoutKey,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { decodeUiKeycode, uiNative } from '../keycodes';
import { isSparklinkId, SPARKLINK_IDS } from './ids';
import { slExtraKeycodes, slName, slToUi, uiToSl } from './keycodes';
import SL_SWITCHES from './switches.json';
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
  getCalibrationRow,
  CALIBRATED,
  calibration,
  axisList,
  PerfCmd,
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
  DKS_BIT,
  setDks,
  setMt,
  setSocdPair,
  getLightBase,
  getPalette,
  lightAreas,
  doubleLighting,
  LIGHT_MAX,
  LIGHT_OPEN_BOTH,
  parseLightAreas,
  parseLightBase,
  parsePalette,
  getLightCells,
  parseLightCells,
  setLightCells,
  LIGHT_CELLS_PER_CHUNK,
  LIGHT_PAINTED,
  LIGHT_PER_KEY_MODE,
  setLightBase,
  setPalette,
  type SlLightBase,
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
    stepMm: number,
    /** Light areas and whether the keys have two LED rows; null without lighting. */
    private readonly light: {
      areas: number[];
      double: boolean;
      /** The keys' LED grid; a key's cell is row * cols + col. */
      grid: { rows: number; cols: number };
    } | null = null,
    /** Keys take a switch from Sparklink's catalog (axisV2Id); see `switchCatalog`. */
    private readonly unlimitedSwitches = false
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
      advancedKeys: ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle', 'macro'],
      maxAdvancedKeys: layout.keys.length,
      advancedKeyLimits: {
        baseLayerOnly: ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle'],
        dksPressPoint: true,
        nullBindBehaviors: ['last', 'primary', 'secondary', 'neutral'],
        nullBindBottomOut: false,
        tapHoldTermMs: { min: 50, max: 2000, step: 10 },
        holdOnOtherKeyPress: false
      },
      dynamicKeystrokeBindings: 4,
      macros: true,
      travelStream: true,
      calibration: true,
      rgb: light !== null,
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
    // an empty switch list means each key stores its own switch from the catalog
    const unlimitedSwitches = await optional(async () => (await ask(axisList()))[3] === 0, false);
    const light = features.rgb
      ? await optional(async () => {
          const list = parseLightAreas(await ask(lightAreas()));
          const keys = list.find(a => a.index === 0);
          if (!keys) return null;
          const areas = list.map(a => a.index);
          const double = await optional(async () => (await ask(doubleLighting()))[3] === 1, false);
          // the base read must work before lighting is offered
          await ask(getLightBase(0));
          return { areas, double, grid: { rows: keys.rows, cols: keys.cols } };
        }, null)
      : null;

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
      stepMm,
      light,
      unlimitedSwitches
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

  /** SOCD, DKS, tap-hold (MT) and toggle (TGL); other kinds set elsewhere are left alone. */
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
      else if (hk.mode === HK.DKS)
        out.push({
          kind: 'dynamicKeystroke',
          layer: 0,
          key,
          keycodes: hk.codes.map(slToUi),
          actions: hk.trps.map(trpsToActions),
          bottomOutMm: hk.bottomUm / 1000,
          pressMm: hk.pressUm / 1000
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
      } else if (ak.kind === 'dynamicKeystroke') {
        const bottomUm = Math.round(ak.bottomOutMm * 1000);
        const was = current[ak.key];
        const pressUm = Math.round(
          (ak.pressMm ?? (was.mode === HK.DKS && 'pressUm' in was ? was.pressUm / 1000 : 0.5)) *
            1000
        );
        if (pressUm >= bottomUm)
          throw new DriverError('A dynamic keystroke’s first point must be above its bottom-out.');
        // same key order as parseHigherKey, so unchanged keys compare equal
        next[ak.key] = {
          mode: HK.DKS,
          codes: [0, 1, 2, 3].map(i => (ak.keycodes[i] ? code(ak.keycodes[i]) : 0)) as [
            number,
            number,
            number,
            number
          ],
          trps: [0, 1, 2, 3].map(i =>
            ak.keycodes[i] && ak.actions[i] ? actionsToTrps(ak.actions[i]) : 0
          ) as [number, number, number, number],
          pressUm,
          bottomUm
        };
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
      else if (hk.mode === HK.DKS && 'trps' in hk)
        await this.ask(setDks(row, col, hk.codes, hk.trps, hk.pressUm, hk.bottomUm));
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

  // ------------------------------------------------------------ switches

  /** Changing a key's switch clears its calibration (the firmware does it). */
  readonly switchChangeNeedsCalibration = true;

  switchCatalog(): SwitchCatalogEntry[] {
    if (!this.unlimitedSwitches) return [];
    return [
      ...SL_SWITCHES.map(sw => ({
        id: `axis-${sw.id}`,
        name: sw.name,
        brand: sw.brand,
        travelMm: sw.travelUm / 1000,
        tunable: false,
        color: sw.color,
        detail: `${(sw.travelUm / 1000).toFixed(2)} mm · ${sw.nameZh}`
      })),
      {
        id: 'unset',
        name: 'Unknown switch',
        brand: 'Other',
        travelMm: this.capabilities.travelMm,
        tunable: false
      }
    ];
  }

  async getSwitchSetup(): Promise<SwitchSetup> {
    if (!this.unlimitedSwitches) throw new DriverError('This board keeps its own switch list.');
    this.perfCache = null;
    const perf = await this.readPerformance(await this.getProfile());
    return {
      keySwitch: perf.map(p => (SWITCH_BY_ID.has(p.axisV2Id) ? `axis-${p.axisV2Id}` : 'unset')),
      tuning: {}
    };
  }

  /**
   * A switch is three fields of each key's performance record: its catalog
   * id, full travel and magnetic coefficient. Keys set to "unknown" keep
   * what they have. The board clears a changed key's calibration.
   */
  async setSwitchSetup(setup: SwitchSetup): Promise<void> {
    if (!this.unlimitedSwitches) throw new DriverError('This board keeps its own switch list.');
    if (setup.keySwitch.length !== this.positions.length)
      throw new RangeError('switch assignment length does not match the board');
    const profile = await this.getProfile();
    this.perfCache = null;
    const current = await this.readPerformance(profile);
    const next = current.map((p, i) => {
      const id = setup.keySwitch[i];
      if (id === 'unset') return p;
      const sw = SWITCH_BY_ID.get(Number(id.replace(/^axis-/, '')));
      if (!sw) throw new DriverError(`Switch "${id}" is not in the catalog.`);
      return { ...p, axisV2Id: sw.id, axisRangeMax: sw.travelUm, axisCoefficient: sw.coefficient };
    });
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

  // ------------------------------------------------------------ calibration

  async startCalibration(): Promise<void> {
    await this.ask(calibration(true));
  }

  /** Per layout key: calibrated. */
  async calibrationProgress(): Promise<boolean[]> {
    const byRow = new Map<number, number[]>();
    for (const row of this.rows)
      byRow.set(row, parseAxisRow(await this.ask(getCalibrationRow(row))));
    return this.positions.map(({ row, col }) => byRow.get(row)?.[col] === CALIBRATED);
  }

  async finishCalibration(): Promise<void> {
    await this.ask(calibration(false));
    await this.ask(save(Area.CALIBRATION));
    this.perfCache = null;
  }

  // ------------------------------------------------------------ lighting

  lightingInfo(): LightingInfo {
    const zone: LightZone = { effects: SL_EFFECTS, brightnessMax: LIGHT_MAX, percent: true };
    return {
      backlight: zone,
      ...(this.light?.areas.includes(1) ? { side: zone } : {}),
      canSwitchOff: true,
      ...(this.cellsOf().some(c => c.length)
        ? { perKey: { mode: LIGHT_PER_KEY_MODE, readable: true, overlay: true } }
        : {})
    };
  }

  /**
   * Each layout key's LED cells: its own (row * cols + col), then, for a key
   * wider than 1u, the cells to its right that no key owns, up to its width
   * (a spacebar's row of LEDs, the second LED under a wide Shift).
   */
  private cellsOf(): number[][] {
    const g = this.light?.grid;
    if (!g || !g.rows || !g.cols) return this.positions.map(() => []);
    const taken = new Set(this.positions.map(p => `${p.row}:${p.col}`));
    return this.positions.map(({ row, col }, i) => {
      if (row >= g.rows || col >= g.cols) return [];
      const cells = [row * g.cols + col];
      const span = Math.ceil(this.layout.keys[i].w - 0.01);
      for (let c = col + 1; c < Math.min(g.cols, col + span) && !taken.has(`${row}:${c}`); c++)
        cells.push(row * g.cols + c);
      return cells;
    });
  }

  private async readCells(): Promise<number[][]> {
    const g = this.light!.grid;
    const chunks = Math.ceil((g.rows * g.cols) / LIGHT_CELLS_PER_CHUNK);
    const cells: number[][] = [];
    for (let c = 0; c < chunks; c++)
      cells.push(...parseLightCells(await this.ask(getLightCells(0, c))));
    return cells;
  }

  async getPerKeyColors(): Promise<Array<number | null>> {
    if (!this.light) throw new DriverError(`${this.info.name} has no lighting OpenHE can set.`);
    const cells = await this.readCells();
    return this.cellsOf().map(own => {
      const cell = cells[own[0]];
      if (!cell || cell[3] !== LIGHT_PAINTED) return null;
      return (cell[2] << 16) | (cell[1] << 8) | cell[0];
    });
  }

  /**
   * The pattern is the whole state: cells not painted here lose their mark
   * (their colour bytes are kept). Only changed chunks are written.
   */
  async setPerKeyColors(colors: ReadonlyArray<number | null>, show: boolean): Promise<void> {
    if (!this.light) throw new DriverError(`${this.info.name} has no lighting OpenHE can set.`);
    const before = await this.readCells();
    const next = before.map(c => [c[0], c[1], c[2], 0]);
    this.cellsOf().forEach((own, key) => {
      const c = colors[key];
      if (c == null) return;
      for (const i of own)
        if (i < next.length) next[i] = [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, LIGHT_PAINTED];
    });
    let wrote = false;
    for (let c = 0; c * LIGHT_CELLS_PER_CHUNK < next.length; c++) {
      const lo = c * LIGHT_CELLS_PER_CHUNK;
      const chunk = next.slice(lo, lo + LIGHT_CELLS_PER_CHUNK);
      const was = before.slice(lo, lo + LIGHT_CELLS_PER_CHUNK);
      // a painted cell's colour matters; an unpainted one only by its mark
      const same = chunk.every((cell, i) =>
        cell[3] === LIGHT_PAINTED
          ? cell.every((b, j) => b === was[i][j])
          : was[i][3] !== LIGHT_PAINTED
      );
      if (same) continue;
      await this.ask(setLightCells(0, c, chunk));
      wrote = true;
    }
    if (show) {
      const base = parseLightBase(await this.ask(getLightBase(0)));
      if (base.mode !== LIGHT_PER_KEY_MODE) {
        await this.ask(setLightBase(0, { ...base, mode: LIGHT_PER_KEY_MODE }));
        wrote = true;
      }
    }
    if (wrote) await this.ask(save(Area.LIGHTING));
  }

  private async readLight(area: number) {
    const base = parseLightBase(await this.ask(getLightBase(area)));
    const palette = parsePalette(await this.ask(getPalette(area)));
    return { base, palette };
  }

  async getLighting(): Promise<LightingState> {
    if (!this.light) throw new DriverError(`${this.info.name} has no lighting OpenHE can set.`);
    const keys = await this.readLight(0);
    const state: LightingState = {
      backlight: toLightSetting(keys.base, keys.palette),
      backlightOff: keys.base.open === 0
    };
    if (this.light.areas.includes(1)) {
      const side = await this.readLight(1);
      state.side = toLightSetting(side.base, side.palette);
      state.sideOff = side.base.open === 0;
    }
    return state;
  }

  /** Effect, brightness, speed and direction; the colour goes in the palette slot it selects. */
  private async writeLight(area: number, setting: LightSetting) {
    if (!this.light?.areas.includes(area))
      throw new DriverError(`${this.info.name} has no such light.`);
    const { base, palette } = await this.readLight(area);
    const slot = setting.rainbow ? 0 : base.colorSlot > 0 ? base.colorSlot : 1;
    let wrote = false;
    if (!setting.rainbow) {
      const c = setting.color;
      const entry = [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, palette[slot][3]];
      if (entry.some((b, i) => b !== palette[slot][i])) {
        palette[slot] = entry;
        await this.ask(setPalette(area, palette));
        wrote = true;
      }
    }
    const next: SlLightBase = {
      ...base,
      mode: setting.mode,
      brightness: Math.round(setting.brightness),
      speed: Math.round(setting.speed),
      direction: setting.option ? 1 : 0,
      colorSlot: slot
    };
    if (JSON.stringify(next) !== JSON.stringify(base)) {
      await this.ask(setLightBase(area, next));
      wrote = true;
    }
    if (wrote) await this.ask(save(Area.LIGHTING));
  }

  setBacklight(setting: LightSetting): Promise<void> {
    return this.writeLight(0, setting);
  }

  setSideLight(setting: LightSetting): Promise<void> {
    return this.writeLight(1, setting);
  }

  async setLightsOff(off: { backlightOff?: boolean; sideOff?: boolean }): Promise<void> {
    if (!this.light) throw new DriverError(`${this.info.name} has no lighting OpenHE can set.`);
    let wrote = false;
    for (const [area, value] of [
      [0, off.backlightOff],
      [1, off.sideOff]
    ] as const) {
      if (value === undefined || !this.light.areas.includes(area)) continue;
      const base = parseLightBase(await this.ask(getLightBase(area)));
      // keys with two LED rows light both; other areas take on/off
      const open = value ? 0 : area === 0 && this.light.double ? LIGHT_OPEN_BOTH : 1;
      if ((base.open === 0) === value) continue;
      await this.ask(setLightBase(area, { ...base, open }));
      wrote = true;
    }
    if (wrote) await this.ask(save(Area.LIGHTING));
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
 * Which of MT's two keycodes is the tap. The vendor's docs do not say; the
 * vendor app's exported settings list the tap first (as device-hub reads them).
 */
const MT_TAP = 0;

const SOCD_BEHAVIOR: Record<number, Extract<AdvancedKey, { kind: 'nullBind' }>['behavior']> = {
  [SOCD_RULE.LAST]: 'last',
  [SOCD_RULE.MINE]: 'primary',
  [SOCD_RULE.OTHER]: 'secondary',
  [SOCD_RULE.NEUTRAL]: 'neutral'
};
const RULE_OF = { last: 'LAST', primary: 'MINE', secondary: 'OTHER', neutral: 'NEUTRAL' } as const;

/**
 * Effects by mode byte, as identified on an SU66 Max by device-hub (camera
 * checks). Boards may name or order theirs differently; every one takes the
 * selected palette colour, and palette slot 0 is rainbow.
 */
const DIR = ['Forward', 'Backward'];
const fx = (mode: number, label: string, extra: Partial<LightEffect> = {}): LightEffect => ({
  mode,
  label,
  color: true,
  speedMax: LIGHT_MAX,
  ...extra
});
const SL_EFFECTS: LightEffect[] = [
  fx(0, 'Static', { speedMax: null }),
  fx(1, 'Rainbow scroll', { options: DIR }),
  fx(2, 'Slow colour shift'),
  fx(3, 'Fast colour shift'),
  fx(4, 'Checkerboard'),
  fx(5, 'Colour cycle'),
  fx(6, 'Pulse'),
  fx(7, 'Moving window', { options: DIR }),
  fx(8, 'Morph'),
  fx(9, 'Colour bands', { options: DIR }),
  fx(10, 'Waves', { options: DIR }),
  fx(11, 'Diagonal sweep', { options: DIR }),
  fx(12, 'Confetti'),
  fx(13, 'Mosaic'),
  fx(14, 'Rain', { options: DIR }),
  fx(15, 'Bounce'),
  fx(16, 'Per-key colours', { color: false, speedMax: null }),
  fx(17, 'Reactive: around the key'),
  fx(18, 'Reactive: row'),
  fx(19, 'Reactive: wide')
];

function toLightSetting(base: SlLightBase, palette: number[][]): LightSetting {
  const [b, g, r] = palette[base.colorSlot > 0 ? base.colorSlot & 7 : 1] ?? [255, 255, 255];
  return {
    mode: base.mode,
    speed: base.speed,
    brightness: base.brightness,
    option: base.direction,
    rainbow: base.colorSlot === 0,
    color: (r << 16) | (g << 8) | b
  };
}

type DksActions = [DksAction, DksAction, DksAction, DksAction];

/**
 * One keycode's trps byte as actions at the four points. A run of held
 * segments is a press where it starts and a release where it ends; a tap bit
 * at a point a run already covers is part of the run.
 */
export function trpsToActions(trps: number): DksActions {
  const out: DksActions = ['hold', 'hold', 'hold', 'hold'];
  const held = DKS_BIT.HOLD.map(bit => (trps & bit) !== 0);
  const covered = [false, false, false, false];
  for (let i = 0; i < 3; i++) {
    if (!held[i] || (i > 0 && held[i - 1])) continue;
    let end = i;
    while (end < 3 && held[end]) end++;
    out[i] = 'press';
    out[end] = 'release';
    for (let p = i; p <= end; p++) covered[p] = true;
  }
  DKS_BIT.TAP.forEach((bit, p) => {
    if (trps & bit && !covered[p]) out[p] = 'tap';
  });
  return out;
}

/** Actions at the four points as a trps byte; a key still down at the end lets go there. */
export function actionsToTrps(actions: readonly DksAction[]): number {
  let trps = 0;
  let down = false;
  for (let p = 0; p < 4; p++) {
    const a = actions[p];
    if (a === 'press') down = true;
    else if (a === 'release') down = false;
    else if (a === 'tap' && !down) trps |= DKS_BIT.TAP[p];
    if (down && p < 3) trps |= DKS_BIT.HOLD[p];
  }
  return trps;
}

const SWITCH_BY_ID = new Map(SL_SWITCHES.map(sw => [sw.id, sw]));

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
  // after one axis-data query the board keeps sending every row and kind by
  // itself until another command comes; take only the row and kind asked for
  const axis = pkt[0] === Group.PERFORMANCE && pkt[1] === PerfCmd.AXIS_DATA;
  const reply = await transport.exchange(
    pkt,
    timeoutMs,
    r => r[0] === pkt[0] && r[1] === pkt[1] && (!axis || (r[2] === pkt[2] && r[3] === pkt[3]))
  );
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
