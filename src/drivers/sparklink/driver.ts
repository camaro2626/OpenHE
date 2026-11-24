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
  type KeyActuation,
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
      advancedKeys: [],
      maxAdvancedKeys: 0,
      dynamicKeystrokeBindings: 0,
      macros: false,
      travelStream: true,
      calibration: false,
      rgb: false,
      gamepad: false,
      pollingRates: rateCodes.map(c => REPORT_RATES_HZ[c]).filter(Boolean),
      releasePoint: true,
      topDeadzone: true,
      bottomDeadzone: true,
      writable: { keymap: true, actuation: true, advancedKeys: false },
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
