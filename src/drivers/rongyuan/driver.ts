/**
 * RongYuan driver: keymap, Fn layer and magnetic switch settings, following
 * what sharkfin does (docs/PROTOCOL.md, protocol/hall.rs, commands.rs):
 *
 * - Family (gen2 / yc500) and lineage come from the registry record of the
 *   id the board reports; never from the USB product ID.
 * - Switch settings are read on gen2 and on yc500 from firmware 2.00, and
 *   written only on the lineages whose write path is evidenced (ry5088 on
 *   gen2, yc3121 on yc500). Other boards are read-only.
 * - Switch columns belong to the active profile. Writes are paced like
 *   sharkfin's: 100 ms between flash pages, 2 s settle after a batch, 10 s
 *   between batches, 400 ms between key writes.
 */

import type { HidDeviceLike } from '../transport';
import {
  DriverError,
  type AdvancedKey,
  type DksAction,
  type LightEffect,
  type LightingInfo,
  type LightingState,
  type LightSetting,
  type LightZone,
  type MacroStep,
  type DeviceOptions,
  type BoardLayout,
  type DeviceInfo,
  type DriverCapabilities,
  type KeyActuation,
  type SwitchCatalogEntry,
  type SwitchSetup,
  type KeyboardDriver,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { entryToUi, nativeEntryLabel, NativeEntries, uiToEntry, type Entry } from './keycodes';
import { decodeUiKeycode, uiHid, uiMomentaryLayer, uiMouseButton } from '../keycodes';
import {
  debouncePacket,
  familyOps,
  kbOptionsPacket,
  ledPacket,
  ledWire,
  LightOp,
  MACRO_ENTRY_TAG,
  macroFromBlob,
  macroPages,
  macroReadPacket,
  macroToBlob,
  macroWritePacket,
  RY_PER_KEY_MODE,
  RY_PER_KEY_SLOTS,
  userpicPackets,
  parseKbOptions,
  parseLed,
  parseSide,
  parseSleep,
  sleepPacket,
  RY_MACRO_SLOTS,
  sidePacket,
  type FamilyOps,
  type LedParam,
  type RyMacroEvent
} from './extras';
import {
  entryAt,
  gridLayout,
  inferLayout,
  layoutFromRegistry,
  MIN_MATCH_RATE,
  type RyLayoutFile
} from './layout';
import {
  Col,
  Columns,
  formatRevision,
  KEYMAP_PAGES,
  keymapReadRequest,
  keyWritePacket,
  Kind,
  MODE_RAPID_TRIGGER,
  Op,
  packet,
  parseTravelReport,
  profileOps,
  revisionWord,
  TRAVEL_STREAM,
  WRITE_COLUMNS,
  type Family
} from './protocol';
import { Wire, WireError } from './wire';

/** One board record from sharkfin's registry (trimmed). */
export type RySpec = {
  id: number;
  displayName?: string;
  company?: string;
  vendorId: number;
  productId: number;
  internalName: string;
  keyLayout: string;
  profiles: number;
  family?: string;
  travel?: Partial<
    Record<
      'travel' | 'firePress' | 'fireLift' | 'deadzone',
      { min: number; max: number; default?: number | null }
    >
  >;
  switchTypes?: Array<{ code: number; name: string }>;
  /** Vendor light table name (light-layouts.json); absent: the common set. */
  light?: string;
  /** LEDPARAM flags nibble read the other way round (8 fixed, 7 rainbow). */
  ledFlagsSwapped?: boolean;
  /** Has an edge / side light. */
  sideLight?: boolean;
  /** Has 2.4 GHz / Bluetooth sleep timers. */
  sleep24?: boolean;
  sleepBT?: boolean;
};

/** One vendor light table (sharkfin data/light-layouts.json). */
export type RyLightTable = {
  rgb: boolean;
  brightnessMax: number;
  effects: Array<{
    mode: number;
    speedMax?: number | null;
    rgb?: boolean;
    options?: Array<string | null> | null;
  }>;
};

export type RyDeps = {
  findSpec(id: number): Promise<RySpec | null>;
  loadLayout(name: string): Promise<RyLayoutFile | null>;
  loadLightTable?(name: string): Promise<RyLightTable | null>;
  /** The owner's answer on the flag order, kept per board (null: none). */
  flagChoice?: FlagChoiceStore;
};

export type FlagChoiceStore = {
  read(id: number): { swapped: boolean; dflt: boolean } | null;
  write(id: number, choice: { swapped: boolean; dflt: boolean } | null): void;
};

const YC500_HALL_REVISION = 0x0200;
const KEY_GAP_MS = 400;
const SETTING_GAP_MS = 1000;
const FLASH_PAGE_GAP_MS = 100;
const FLASH_SETTLE_MS = 2000;
const FLASH_COOLDOWN_MS = 10000;
/** Lighting is flash too: one write per second at most. */
const LIGHT_GAP_MS = 1000;

const ACTUATION_COLUMNS = [
  Col.MODE,
  Col.TRAVEL,
  Col.LIFT,
  Col.RT_PRESS,
  Col.RT_LIFT,
  Col.DEAD_BOTTOM,
  Col.DKS_START,
  Col.MT_TIME,
  Col.SNAP_PARTNER
] as const;
/** Firmware toggle: held past 60 ticks of 5 ms it acts as a plain key. */
const TOGGLE_TERM_MS = 300;
const NO_PARTNER = 0xff;

export function hallReads(spec: RySpec, family: Family, revision: number | null): boolean {
  if (family === 'gen2') return true;
  return revision !== null && revision >= YC500_HALL_REVISION;
}

export function hallWrites(spec: RySpec, family: Family, revision: number | null): boolean {
  if (!hallReads(spec, family, revision)) return false;
  return family === 'gen2'
    ? spec.internalName.startsWith('ry5088_')
    : spec.internalName.startsWith('yc3121_');
}

export class RongyuanDriver implements KeyboardDriver {
  readonly id = 'rongyuan' as const;
  /** An empty Fn-layer slot passes through to the base layer. */
  readonly transparentKeycode = 0;
  readonly capabilities: DriverCapabilities;
  layout: BoardLayout;
  /** Matrix slot of each layout key. */
  private slots: number[];
  /** An inferred picture must be confirmed before keymap/switch writes. */
  private layoutConfirmed: boolean;
  readonly matchRate: number;

  private readonly natives = new NativeEntries();
  private readonly keymapCache = new Map<string, Uint8Array>();
  private columnsCache: { profile: number; values: Map<number, number[]> } | null = null;
  private lastWrite = -Infinity;
  private lastFlash = -Infinity;
  private readonly ops: FamilyOps;
  private readonly factory: Array<Entry | null>;
  private flagsSwapped: boolean;
  private readonly lightTable: RyLightTable | null;
  private readonly flagStore: FlagChoiceStore | null;

  private constructor(
    private readonly wire: Wire,
    readonly info: DeviceInfo,
    readonly spec: RySpec,
    readonly family: Family,
    readonly revision: number | null,
    private readonly columns: Columns | null,
    resolved: {
      layout: BoardLayout;
      slots: number[];
      matchRate: number;
      factory?: Array<Entry | null>;
    },
    private readonly streamDevices: HidDeviceLike[],
    private readonly closeNode: () => Promise<void>,
    extras: { lightTable: RyLightTable | null; flagStore: FlagChoiceStore | null } = {
      lightTable: null,
      flagStore: null
    }
  ) {
    this.ops = familyOps(family);
    this.factory = resolved.factory ?? resolved.slots.map(() => null);
    this.lightTable = extras.lightTable;
    this.flagStore = extras.flagStore;
    // the owner's answer stands while the registry still says what it said then
    const dflt = !!spec.ledFlagsSwapped;
    const choice = this.flagStore?.read(spec.id) ?? null;
    if (choice && choice.dflt !== dflt) this.flagStore?.write(spec.id, null);
    this.flagsSwapped = choice && choice.dflt === dflt ? choice.swapped : dflt;
    this.layout = resolved.layout;
    this.slots = resolved.slots;
    this.matchRate = resolved.matchRate;
    this.layoutConfirmed = resolved.layout.source !== 'inferred';
    const t = spec.travel;
    const switchWrites = columns !== null && hallWrites(spec, family, revision);
    this.capabilities = {
      profiles: spec.profiles,
      layers: 2,
      travelMm: t?.travel?.max ?? 4,
      travelStepMm: columns?.unitMm ?? 0.1,
      actuation: columns !== null,
      rapidTrigger: columns !== null,
      rapidTriggerSplit: columns !== null,
      continuousRapidTrigger: false,
      advancedKeys: switchWrites
        ? ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle', 'macro']
        : ['macro'],
      maxAdvancedKeys: switchWrites ? resolved.slots.length : RY_MACRO_SLOTS,
      dynamicKeystrokeBindings: switchWrites ? 4 : 0,
      advancedKeyLimits: {
        baseLayerOnly: ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle'],
        nullBindBehaviors: ['last'],
        nullBindBottomOut: false,
        dksOneActionPerKeycode: true,
        dksPressPoint: true,
        dksBottomOutIsActuation: true,
        tapHoldTermMs: { min: 10, max: 2550, step: 10 },
        holdOnOtherKeyPress: false,
        toggleTermFixedMs: TOGGLE_TERM_MS,
        toggleRepeat: true
      },
      macros: true,
      travelStream: columns?.format === 'gen2' && !wire.relay && streamDevices.length > 0,
      calibration: false,
      rgb: true,
      gamepad: false,
      pollingRates: [],
      releasePoint: columns !== null,
      topDeadzone: false,
      bottomDeadzone: columns !== null,
      writable: { keymap: true, actuation: switchWrites, advancedKeys: true },
      actuationActiveProfileOnly: true,
      ranges: {
        ...(t?.travel ? { actuation: { min: t.travel.min, max: t.travel.max } } : {}),
        ...(t?.firePress ? { rapidTrigger: { min: t.firePress.min, max: t.firePress.max } } : {}),
        ...(t?.deadzone ? { deadzone: { min: t.deadzone.min, max: t.deadzone.max } } : {})
      }
    };
  }

  static async connect(
    wire: Wire,
    deps: RyDeps,
    usb: { vendorId: number; productId: number; productName: string },
    options: { streamDevices?: HidDeviceLike[]; close?: () => Promise<void> } = {}
  ): Promise<RongyuanDriver> {
    const id = await wire.exclusive(() => wire.identify());
    const spec = await deps.findSpec(id);
    if (!spec)
      throw new DriverError(`This RongYuan board (device ${id}) is not in the board list yet.`);
    const family = spec.family === 'gen2' || spec.family === 'yc500' ? spec.family : null;
    if (!family)
      throw new DriverError(
        `${spec.displayName ?? spec.internalName}: its command set is not established yet.`
      );

    const revision = await wire.exclusive(async () => {
      try {
        const rev = revisionWord(await wire.roundtrip(packet(Op.GET_REVISION)), 1);
        if (rev !== null || family !== 'gen2') return rev;
        return revisionWord(await wire.roundtrip(packet(Op.IDENTIFY)), 7);
      } catch {
        return null;
      }
    });
    const columns = hallReads(spec, family, revision)
      ? family === 'gen2'
        ? Columns.gen2(revision)
        : Columns.yc500()
      : null;

    const profile =
      (await wire.exclusive(() => wire.roundtrip(packet(profileOps(family).get)))).at(1) ?? 0;
    const file = await deps.loadLayout(spec.keyLayout);
    let resolved = file ? layoutFromRegistry(file) : null;
    if (!resolved) {
      const matrix = await wire.exclusive(() => readMatrix(wire, family, profile, false));
      const inferred = file ? inferLayout(file, matrix) : null;
      resolved =
        inferred && inferred.matchRate >= MIN_MATCH_RATE
          ? inferred
          : gridLayout(matrix, columns?.slots ?? 128);
    }

    const name = [spec.company, spec.displayName].filter(Boolean).join(' ') || usb.productName;
    const lightTable = spec.light ? ((await deps.loadLightTable?.(spec.light)) ?? null) : null;
    const driver = new RongyuanDriver(
      wire,
      {
        name,
        firmwareVersion: formatRevision(revision),
        vendorId: usb.vendorId,
        productId: usb.productId
      },
      spec,
      family,
      revision,
      columns,
      resolved,
      options.streamDevices ?? [],
      options.close ?? (async () => undefined),
      { lightTable, flagStore: deps.flagChoice ?? null }
    );
    return driver;
  }

  /** The user looked at an inferred picture and says it is their board. */
  confirmLayout(): void {
    this.layoutConfirmed = true;
  }

  get needsLayoutConfirmation(): boolean {
    return !this.layoutConfirmed;
  }

  close(): Promise<void> {
    return this.closeNode();
  }

  private checkProfile(profile: number) {
    if (!Number.isInteger(profile) || profile < 0 || profile >= this.spec.profiles) {
      throw new RangeError(`profile ${profile} out of range`);
    }
  }

  private requireConfirmedLayout() {
    if (!this.layoutConfirmed) {
      throw new DriverError('Confirm that the picture matches your keyboard before writing to it.');
    }
  }

  private async gap(ms: number) {
    const wait = this.lastWrite + ms - this.wire.clock.now();
    if (wait > 0) await this.wire.clock.sleep(wait);
  }

  private stamp() {
    this.lastWrite = this.wire.clock.now();
  }

  async getProfile(): Promise<number> {
    const reply = await this.wire.exclusive(() =>
      this.wire.roundtrip(packet(profileOps(this.family).get))
    );
    return reply[1];
  }

  /** Switch the board's active profile (switch columns follow it). */
  async setProfile(profile: number): Promise<void> {
    this.checkProfile(profile);
    await this.wire.exclusive(async () => {
      await this.gap(SETTING_GAP_MS);
      await this.wire.send(packet(profileOps(this.family).set, [profile]));
      this.stamp();
    });
    this.columnsCache = null;
  }

  private async matrix(
    profile: number,
    fnLayer: boolean,
    fresh = false,
    sublayer = 0
  ): Promise<Uint8Array> {
    const key = `${profile}:${fnLayer ? 1 : 0}:${sublayer}`;
    const cached = this.keymapCache.get(key);
    if (cached && !fresh) return cached;
    const m = await this.wire.exclusive(() =>
      readMatrix(this.wire, this.family, profile, fnLayer, sublayer)
    );
    this.keymapCache.set(key, m);
    return m;
  }

  async getKeymap(profile: number, layer: number): Promise<UiKeycode[]> {
    this.checkProfile(profile);
    if (layer !== 0 && layer !== 1) throw new RangeError(`layer ${layer} out of range`);
    const m = await this.matrix(profile, layer === 1, true);
    return this.slots.map(slot => entryToUi(entryAt(m, slot), this.natives));
  }

  async setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void> {
    this.checkProfile(profile);
    this.requireConfirmedLayout();
    if (layer !== 0 && layer !== 1) throw new RangeError(`layer ${layer} out of range`);
    if (keymap.length !== this.slots.length)
      throw new RangeError('keymap length does not match the board');
    const fnLayer = layer === 1;
    const entries = keymap.map((kc, i) => {
      const e = uiToEntry(kc, this.natives);
      if (!e)
        throw new DriverError(
          `Key ${this.layout.keys[i]?.label || i}: this keycode is not available on this board`
        );
      return e;
    });
    const current = await this.matrix(profile, fnLayer);
    const changes = entries
      .map((e, i) => ({ slot: this.slots[i], entry: e }))
      .filter(({ slot, entry }) => !sameEntry(entryAt(current, slot), entry));
    for (const { slot, entry } of changes) {
      await this.wire.exclusive(async () => {
        await this.gap(KEY_GAP_MS);
        const pkt = keyWritePacket(this.family, profile, slot, entry, fnLayer);
        await this.wire.send(pkt);
        this.stamp();
        if (this.family === 'yc500') await this.verifyYc500Slot(pkt, profile, slot, entry, fnLayer);
      });
      current.set(entry, slot * 4);
    }
  }

  /** yc500 firmware without the single-slot write drops it silently; look three times. */
  private async verifyYc500Slot(
    pkt: Uint8Array,
    profile: number,
    slot: number,
    entry: Entry,
    fnLayer: boolean,
    sublayer = 0
  ) {
    for (const wait of [10, 50, 150]) {
      await this.wire.clock.sleep(wait);
      const page = await this.wire.readRawPage(
        keymapReadRequest('yc500', profile, slot >> 4, fnLayer, sublayer)
      );
      if (page[0] === pkt[0]) continue;
      if (sameEntry(entryAt(page, slot % 16), entry)) return;
    }
    throw new DriverError('The keyboard did not take the key write.');
  }

  supportsKeycode(value: UiKeycode): boolean {
    return uiToEntry(value, this.natives) !== null;
  }

  keycodeLabel(value: UiKeycode): string | null {
    const d = decodeUiKeycode(value);
    if (d.type === 'layer') return 'Fn';
    if (d.type !== 'native') return null;
    const e = this.natives.entry(d.code);
    return e ? nativeEntryLabel(e) : null;
  }

  extraKeycodes(): Array<{ value: UiKeycode; label: string }> {
    return [{ value: uiMomentaryLayer(1), label: 'Fn' }];
  }

  /** Factory base layer from the layout file, where it gives every key's entry. */
  defaultKeymap(layer = 0): UiKeycode[] | null {
    if (layer !== 0 || this.factory.some(e => e === null)) return null;
    return this.factory.map(e => entryToUi(e!, this.natives));
  }

  private async ensureActiveProfile(profile: number) {
    this.checkProfile(profile);
    if ((await this.getProfile()) !== profile) await this.setProfile(profile);
  }

  private async readColumns(profile: number): Promise<Map<number, number[]>> {
    const f = this.columns;
    if (!f) throw new DriverError('This board has no magnetic switch settings to read.');
    if (this.columnsCache?.profile === profile) return this.columnsCache.values;
    await this.ensureActiveProfile(profile);
    const values = new Map<number, number[]>();
    await this.wire.exclusive(async () => {
      for (const col of ACTUATION_COLUMNS) {
        const pages: Uint8Array[] = [];
        for (let page = 0; page < f.getPages(col); page++)
          pages.push(await this.wire.readRawPage(f.readRequest(col, page)));
        values.set(col, f.decode(col, concat(pages)));
      }
    });
    this.columnsCache = { profile, values };
    return values;
  }

  async getActuation(profile: number): Promise<KeyActuation[]> {
    const f = this.columns;
    const cols = await this.readColumns(profile);
    if (!f) return [];
    const v = (col: number, slot: number) => cols.get(col)?.[slot] ?? 0;
    return this.slots.map(slot => {
      const rt = (v(Col.MODE, slot) & MODE_RAPID_TRIGGER) !== 0;
      const press = f.toMm(Col.RT_PRESS, v(Col.RT_PRESS, slot));
      const release = f.toMm(Col.RT_LIFT, v(Col.RT_LIFT, slot));
      const bottom = f.toMm(Col.DEAD_BOTTOM, v(Col.DEAD_BOTTOM, slot));
      return {
        actuationMm: f.toMm(Col.TRAVEL, v(Col.TRAVEL, slot)),
        rapidTrigger: rt,
        // the firmware has no split flag: two different values are a split
        splitSensitivity: Math.abs(press - release) > 1e-6,
        rtPressMm: press,
        rtReleaseMm: release,
        continuous: false,
        // nor a dead zone switch: a zero bottom dead zone is "off"
        deadzoneEnabled: bottom > 0,
        topDeadzoneMm: 0,
        bottomDeadzoneMm: bottom,
        releaseMm: f.toMm(Col.LIFT, v(Col.LIFT, slot))
      };
    });
  }

  async setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void> {
    const f = this.columns;
    if (!f || !this.capabilities.writable.actuation) {
      throw new DriverError(
        `Switch settings on ${this.info.name} can be read but not written yet.`
      );
    }
    this.requireConfirmedLayout();
    if (actuation.length !== this.slots.length)
      throw new RangeError('actuation length does not match the board');
    const cols = await this.readColumns(profile);
    const next = new Map<number, number[]>([...cols].map(([c, vals]) => [c, [...vals]]));
    actuation.forEach((a, i) => {
      const slot = this.slots[i];
      const set = (col: number, value: number) => {
        const arr = next.get(col);
        if (arr) arr[slot] = value;
      };
      const mode = cols.get(Col.MODE)?.[slot] ?? 0;
      set(Col.MODE, (mode & 0x7f) | (a.rapidTrigger ? MODE_RAPID_TRIGGER : 0));
      set(Col.TRAVEL, f.toWire(Col.TRAVEL, a.actuationMm));
      // sensitivities are written even with Rapid Trigger off, so turning it
      // back on restores them
      set(Col.RT_PRESS, f.toWire(Col.RT_PRESS, a.rtPressMm));
      set(Col.RT_LIFT, f.toWire(Col.RT_LIFT, a.splitSensitivity ? a.rtReleaseMm : a.rtPressMm));
      if (a.releaseMm !== undefined) set(Col.LIFT, f.toWire(Col.LIFT, a.releaseMm));
      set(Col.DEAD_BOTTOM, f.toWire(Col.DEAD_BOTTOM, a.deadzoneEnabled ? a.bottomDeadzoneMm : 0));
    });

    const changedSlots = new Set<number>();
    const changedCols: number[] = [];
    for (const col of WRITE_COLUMNS) {
      const before = cols.get(col) ?? [];
      const after = next.get(col) ?? [];
      let changed = false;
      after.forEach((v, s) => {
        if (v !== before[s]) {
          changed = true;
          changedSlots.add(s);
        }
      });
      if (changed) changedCols.push(col);
    }
    if (!changedSlots.size) return;

    await this.wire.exclusive(async () => {
      const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
      if (cooldown > 0) await this.wire.clock.sleep(cooldown);
      if (changedSlots.size <= 2) {
        // sharkfin's per-key path: the six plain columns, the last one flagged
        for (const slot of changedSlots) {
          for (const [i, col] of WRITE_COLUMNS.entries()) {
            const pkt = f.setOne(
              col,
              slot,
              i === WRITE_COLUMNS.length - 1,
              next.get(col)?.[slot] ?? 0
            );
            if (!pkt) throw new DriverError('slot out of range');
            await this.wire.send(pkt);
          }
          await this.wire.clock.sleep(FLASH_SETTLE_MS);
        }
      } else {
        // whole columns in bulk pages, the final page of the final column flagged
        for (const [i, col] of changedCols.entries()) {
          for (const pkt of f.setAll(col, next.get(col) ?? [], i === changedCols.length - 1)) {
            await this.wire.send(pkt);
            await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
          }
        }
        await this.wire.clock.sleep(FLASH_SETTLE_MS);
      }
      this.lastFlash = this.wire.clock.now();
      this.stamp();
    });
    this.columnsCache = { profile, values: next };
  }

  /**
   * Switch Selector: the board's per-key switch model (column 252), offered
   * only where the board's registry record lists the vendor's switch models,
   * and written only with a listed code, as sharkfin does.
   */
  switchCatalog(): SwitchCatalogEntry[] {
    const listed = this.spec.switchTypes ?? [];
    if (!this.columns || !listed.length) return [];
    return [
      ...listed.map(t => ({
        id: `code-${t.code}`,
        name: t.name,
        brand: this.spec.company ?? 'RongYuan',
        travelMm: this.capabilities.travelMm,
        tunable: false
      })),
      {
        id: 'unset',
        name: 'Not set',
        brand: this.spec.company ?? 'RongYuan',
        travelMm: this.capabilities.travelMm,
        tunable: false
      }
    ];
  }

  private switchCodes: number[] | null = null;

  async getSwitchSetup(): Promise<SwitchSetup> {
    const f = this.columns;
    const listed = new Set((this.spec.switchTypes ?? []).map(t => t.code));
    if (!f || !listed.size) throw new DriverError('This board does not list switch models.');
    const codes = await this.wire.exclusive(async () => {
      const pages: Uint8Array[] = [];
      for (let page = 0; page < f.getPages(Col.SWITCH_TYPE); page++) {
        pages.push(await this.wire.readRawPage(f.readRequest(Col.SWITCH_TYPE, page)));
      }
      return f.decode(Col.SWITCH_TYPE, concat(pages));
    });
    this.switchCodes = codes;
    return {
      keySwitch: this.slots.map(slot =>
        listed.has(codes[slot]) ? `code-${codes[slot]}` : 'unset'
      ),
      tuning: {}
    };
  }

  async setSwitchSetup(setup: SwitchSetup): Promise<void> {
    const f = this.columns;
    if (!f || !this.capabilities.writable.actuation) {
      throw new DriverError(
        `Switch settings on ${this.info.name} can be read but not written yet.`
      );
    }
    this.requireConfirmedLayout();
    if (setup.keySwitch.length !== this.slots.length) {
      throw new RangeError('switch assignment length does not match the board');
    }
    const listed = new Set((this.spec.switchTypes ?? []).map(t => t.code));
    const before = this.switchCodes ?? (await this.getSwitchSetup(), this.switchCodes!);
    const next = [...before];
    setup.keySwitch.forEach((id, i) => {
      if (id === 'unset') return; // an unlisted code goes back as it was
      const code = Number(id.replace(/^code-/, ''));
      if (!listed.has(code)) throw new DriverError(`Switch "${id}" is not offered for this board.`);
      next[this.slots[i]] = code;
    });
    if (next.every((v, i) => v === before[i])) return;
    await this.wire.exclusive(async () => {
      const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
      if (cooldown > 0) await this.wire.clock.sleep(cooldown);
      for (const pkt of f.setAll(Col.SWITCH_TYPE, next, true)) {
        await this.wire.send(pkt);
        await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
      }
      await this.wire.clock.sleep(FLASH_SETTLE_MS);
      this.lastFlash = this.wire.clock.now();
      this.stamp();
    });
    this.switchCodes = next;
  }

  // ------------------------------------------------------------ lighting

  private get wireLed() {
    return ledWire(this.family, this.flagsSwapped, this.lightTable?.brightnessMax ?? 4);
  }

  lightingInfo(): LightingInfo {
    const table = this.lightTable;
    const effects: LightEffect[] = table
      ? table.effects
          .filter(e => e.mode in MODE_LABELS)
          .map(e => ({
            mode: e.mode,
            label: MODE_LABELS[e.mode],
            ...(e.options ? { options: e.options } : {}),
            color: !!e.rgb,
            speedMax: e.speedMax == null ? null : Math.min(e.speedMax, 4)
          }))
      : COMMON_EFFECTS;
    const backlight: LightZone = { effects, brightnessMax: Math.max(1, table?.brightnessMax ?? 4) };
    return {
      backlight,
      ...(this.spec.sideLight
        ? { side: { effects: SIDE_EFFECTS, brightnessMax: 4, offMode: 0 } }
        : {}),
      canSwitchOff: this.ops.kbOption !== null,
      perKey: { mode: RY_PER_KEY_MODE, readable: false, overlay: false },
      flagOrder: {
        swapped: this.flagsSwapped,
        fromRegistry: this.flagsSwapped === !!this.spec.ledFlagsSwapped
      }
    };
  }

  setLightFlagOrder(swapped: boolean): void {
    this.flagsSwapped = swapped;
    const dflt = !!this.spec.ledFlagsSwapped;
    this.flagStore?.write(this.spec.id, swapped === dflt ? null : { swapped, dflt });
  }

  async getLighting(): Promise<LightingState> {
    return this.wire.exclusive(async () => {
      const led = parseLed(await this.wire.roundtrip(packet(LightOp.GET_LED)), this.wireLed);
      if (!led) throw new DriverError('The keyboard gave an unexpected lighting reply.');
      const state: LightingState = { backlight: toSetting(led) };
      if (this.spec.sideLight) {
        const side = parseSide(
          await this.wire.roundtrip(packet(LightOp.GET_SIDE)),
          this.flagsSwapped
        );
        if (side) state.side = toSetting(side);
      }
      const kb = this.ops.kbOption;
      if (kb) {
        const o = parseKbOptions(await this.wire.roundtrip(packet(kb.get, [0])), kb.get);
        if (o) {
          state.backlightOff = o.backlightOff;
          if (this.spec.sideLight) state.sideOff = o.sideLightOff;
        }
      }
      return state;
    });
  }

  private async lightWrite(pkt: Uint8Array) {
    await this.wire.exclusive(async () => {
      await this.gap(LIGHT_GAP_MS);
      await this.wire.send(pkt);
      this.stamp();
    });
  }

  async setBacklight(setting: LightSetting): Promise<void> {
    await this.lightWrite(ledPacket(fromSetting(setting), this.wireLed));
  }

  /**
   * The per-key pattern, by layout key (null = off), written to flash in
   * pages; the board cannot read it back. `show` switches the backlight to
   * the per-key effect, keeping its brightness.
   */
  async setPerKeyColors(colors: ReadonlyArray<number | null>, show: boolean): Promise<void> {
    if (this.wire.relay)
      throw new DriverError('Plug the keyboard in by cable to write per-key colours.');
    const blob = new Uint8Array(RY_PER_KEY_SLOTS * 3);
    this.slots.forEach((slot, key) => {
      const c = colors[key];
      if (c == null || slot < 0 || slot >= RY_PER_KEY_SLOTS) return;
      blob.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff], slot * 3);
    });
    await this.wire.exclusive(async () => {
      const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
      if (cooldown > 0) await this.wire.clock.sleep(cooldown);
      // ask about the mode before the upload, not while the board writes flash
      const led = show
        ? parseLed(await this.wire.roundtrip(packet(LightOp.GET_LED)), this.wireLed)
        : null;
      for (const pkt of userpicPackets(this.spec.family === 'gen2' ? 'gen2' : 'yc500', blob)) {
        await this.wire.send(pkt);
        await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
      }
      await this.wire.clock.sleep(FLASH_SETTLE_MS);
      if (show && led?.mode !== RY_PER_KEY_MODE) {
        await this.wire.send(
          ledPacket(
            {
              mode: RY_PER_KEY_MODE,
              speed: 2,
              brightness: led?.brightness ?? this.wireLed.brightnessMax,
              option: 0,
              rainbow: false,
              color: [0, 200, 200]
            },
            this.wireLed
          )
        );
      }
      this.lastFlash = this.wire.clock.now();
      this.stamp();
    });
  }

  async setSideLight(setting: LightSetting): Promise<void> {
    if (!this.spec.sideLight) throw new DriverError(`${this.info.name} has no edge light.`);
    await this.lightWrite(sidePacket(fromSetting(setting), this.flagsSwapped));
  }

  async setLightsOff(off: { backlightOff?: boolean; sideOff?: boolean }): Promise<void> {
    const kb = this.ops.kbOption;
    if (!kb) throw new DriverError('This board turns its lights off with an effect, not a switch.');
    await this.wire.exclusive(async () => {
      await this.gap(LIGHT_GAP_MS);
      const cur = await this.wire.roundtrip(packet(kb.get, [0]));
      const o = parseKbOptions(cur, kb.get);
      if (!o) throw new DriverError('The keyboard gave an unexpected options reply.');
      if (off.backlightOff !== undefined) o.backlightOff = off.backlightOff;
      if (off.sideOff !== undefined) o.sideLightOff = off.sideOff;
      await this.wire.send(kbOptionsPacket(o, kb.set, cur));
      this.stamp();
    });
  }

  // ------------------------------------------------------------ settings

  async getOptions(): Promise<DeviceOptions> {
    return this.wire.exclusive(async () => {
      const out: DeviceOptions = {};
      const deb = await this.wire.roundtrip(packet(this.ops.getDebounce));
      if (deb[0] === this.ops.getDebounce) out.debounce = deb[this.ops.debounceAt];
      const kb = this.ops.kbOption;
      if (kb) {
        const o = parseKbOptions(await this.wire.roundtrip(packet(kb.get, [0])), kb.get);
        if (o) Object.assign(out, { winLock: o.winLock, wasdSwap: o.wasdSwap, macMode: o.macMode });
      }
      if (this.spec.sleep24 || this.spec.sleepBT) {
        const t = parseSleep(await this.wire.roundtrip(packet(this.ops.getSleep)), this.ops);
        if (t) {
          out.sleep = {
            ...(this.spec.sleep24 ? { sleep24: t.sleep24, deep24: t.deep24 } : {}),
            ...(this.spec.sleepBT ? { sleepBt: t.sleepBt, deepBt: t.deepBt } : {})
          };
        }
      }
      try {
        const auto = await this.wire.roundtrip(packet(LightOp.GET_AUTO_OS));
        if (auto[0] === LightOp.GET_AUTO_OS) out.autoOs = auto[1] === 1;
      } catch {
        // not every board answers; leave it out
      }
      return out;
    });
  }

  async setOptions(options: DeviceOptions): Promise<void> {
    await this.wire.exclusive(async () => {
      if (options.debounce !== undefined) {
        await this.gap(SETTING_GAP_MS);
        await this.wire.send(debouncePacket(this.ops, options.debounce));
        this.stamp();
      }
      const kb = this.ops.kbOption;
      if (kb && (options.winLock !== undefined || options.wasdSwap !== undefined)) {
        await this.gap(SETTING_GAP_MS);
        const cur = await this.wire.roundtrip(packet(kb.get, [0]));
        const o = parseKbOptions(cur, kb.get);
        if (!o) throw new DriverError('The keyboard gave an unexpected options reply.');
        if (options.winLock !== undefined) o.winLock = options.winLock;
        if (options.wasdSwap !== undefined) o.wasdSwap = options.wasdSwap;
        await this.wire.send(kbOptionsPacket(o, kb.set, cur));
        this.stamp();
      }
      if (options.sleep && (this.spec.sleep24 || this.spec.sleepBT)) {
        // all four go in one packet: start from what the board has
        await this.gap(SETTING_GAP_MS);
        const cur = parseSleep(await this.wire.roundtrip(packet(this.ops.getSleep)), this.ops);
        if (!cur) throw new DriverError('The keyboard gave an unexpected sleep timer reply.');
        const next = { ...cur };
        for (const k of ['sleep24', 'sleepBt', 'deep24', 'deepBt'] as const) {
          const v = options.sleep[k];
          if (v !== undefined) next[k] = Math.round(v);
        }
        await this.wire.send(sleepPacket(this.ops, next));
        this.stamp();
      }
      if (options.autoOs !== undefined) {
        await this.gap(SETTING_GAP_MS);
        await this.wire.send(packet(LightOp.SET_AUTO_OS, [options.autoOs ? 1 : 0]));
        this.stamp();
      }
    });
  }

  /** Wipes every profile, keymap, macro and light setting on the board. */
  async factoryReset(): Promise<void> {
    if (this.wire.relay) throw new DriverError('Plug the keyboard in by cable to reset it.');
    await this.wire.exclusive(async () => {
      await this.gap(SETTING_GAP_MS);
      await this.wire.send(packet(this.ops.reset));
      await this.wire.clock.sleep(this.ops.resetSettleMs);
      this.stamp();
    });
    this.keymapCache.clear();
    this.columnsCache = null;
    this.switchCodes = null;
  }

  // ------------------------------------------------------------ macros

  private async readMacroBlob(slot: number): Promise<Uint8Array> {
    return this.wire.exclusive(async () => {
      const pages: Uint8Array[] = [];
      for (let page = 0; page < 4; page++)
        pages.push((await this.wire.readRawPage(macroReadPacket(slot, page))).subarray(0, 64));
      return concat(pages);
    });
  }

  // ------------------------------------------------- advanced keys

  /** Every key's dynamic keystroke action bytes, four blocks (one per sub-layer). */
  private dksCache: { profile: number; blocks: number[][] } | null = null;

  private get kindWrites(): boolean {
    return this.columns !== null && this.capabilities.writable.actuation;
  }

  /** Sub-op 10: four blocks of one byte a slot, two raw pages a block. */
  private async readDksActions(profile: number): Promise<number[][]> {
    const f = this.columns!;
    if (this.dksCache?.profile === profile) return this.dksCache.blocks;
    const blocks = await this.wire.exclusive(async () => {
      const out: number[][] = [];
      for (let block = 0; block < 4; block++) {
        const raw: number[] = [];
        for (const page of [2 * block, 2 * block + 1])
          raw.push(...(await this.wire.readRawPage(f.readRequest(Col.DKS_ACTIONS_ALL, page))));
        out.push(raw.slice(0, f.slots));
      }
      return out;
    });
    this.dksCache = { profile, blocks };
    return blocks;
  }

  /**
   * Macros (keymap entries) plus, where switch settings are written, the
   * key kinds sharkfin writes: snap (SOCD), dynamic keystroke, mod-tap and
   * toggle, from the mode column and keymap sub-layers 0..3.
   */
  async getAdvancedKeys(profile: number): Promise<AdvancedKey[]> {
    this.checkProfile(profile);
    const out = await this.getMacroKeys(profile);
    const f = this.columns;
    if (!f || !this.kindWrites) return out;
    this.columnsCache = null;
    this.dksCache = null;
    const cols = await this.readColumns(profile);
    const v = (col: number, slot: number) => cols.get(col)?.[slot] ?? 0;
    const kinds = this.slots.map(s => v(Col.MODE, s) & 0x7f);
    if (!kinds.some(k => k !== Kind.NORMAL)) return out;
    const subs: Uint8Array[] = [];
    for (let i = 0; i < 4; i++) subs.push(await this.matrix(profile, false, true, i));
    const dks = kinds.includes(Kind.DKS) ? await this.readDksActions(profile) : [];
    const ui = (sub: number, s: number) => entryToUi(entryAt(subs[sub], s), this.natives);
    const indexOfSlot = new Map(this.slots.map((s, i) => [s, i]));
    this.slots.forEach((s, key) => {
      switch (kinds[key]) {
        case Kind.DKS:
          out.push({
            kind: 'dynamicKeystroke',
            layer: 0,
            key,
            keycodes: [0, 1, 2, 3].map(i => ui(i, s)),
            actions: [0, 1, 2, 3].map(i => dksToStages(dks[i]?.[s] ?? 0)),
            bottomOutMm: f.toMm(Col.TRAVEL, v(Col.TRAVEL, s)),
            pressMm: f.toMm(Col.DKS_START, v(Col.DKS_START, s))
          });
          break;
        case Kind.MOD_TAP:
          out.push({
            kind: 'tapHold',
            layer: 0,
            key,
            hold: ui(0, s),
            tap: ui(1, s),
            tappingTermMs: Math.max(10, v(Col.MT_TIME, s) * 10),
            holdOnOtherKeyPress: false
          });
          break;
        case Kind.TOGGLE_HOLD:
        case Kind.TOGGLE_TAP:
          out.push({
            kind: 'toggle',
            layer: 0,
            key,
            keycode: ui(0, s),
            tappingTermMs: TOGGLE_TERM_MS,
            repeating: kinds[key] === Kind.TOGGLE_TAP
          });
          break;
        case Kind.SNAP: {
          const partner = indexOfSlot.get(v(Col.SNAP_PARTNER, s));
          // one entry per pair, from the lower key
          if (partner !== undefined && partner < key && kinds[partner] === Kind.SNAP) break;
          out.push({
            kind: 'nullBind',
            layer: 0,
            key,
            secondaryKey: partner ?? key,
            behavior: 'last',
            bottomOutMm: 0
          });
          break;
        }
      }
    });
    return out;
  }

  async setAdvancedKeys(profile: number, keys: readonly AdvancedKey[]): Promise<void> {
    this.checkProfile(profile);
    this.requireConfirmedLayout();
    const kindKeys = keys.filter(k => k.kind !== 'macro');
    const f = this.columns;
    if (kindKeys.length && (!f || !this.kindWrites))
      throw new DriverError(`${this.info.name} stores only macros as advanced keys.`);
    for (const ak of kindKeys) {
      if (ak.layer !== 0)
        throw new DriverError('Advanced keys other than macros work on the base layer only.');
      if (ak.kind === 'nullBind' && ak.behavior !== 'last')
        throw new DriverError('This board’s SOCD lets the last key pressed win.');
    }
    await this.setMacroKeys(profile, keys);
    if (!f || !this.kindWrites) return;
    const macroKeys = new Set(
      keys.filter(k => k.kind === 'macro' && k.layer === 0).map(k => k.key)
    );
    await this.setKindKeys(profile, f, kindKeys, macroKeys);
  }

  private async setKindKeys(
    profile: number,
    f: Columns,
    keys: readonly AdvancedKey[],
    /** Base-layer keys that now carry a macro: their keymap entry is already written. */
    macroKeys: ReadonlySet<number> = new Set()
  ) {
    this.columnsCache = null;
    this.dksCache = null;
    const cols = await this.readColumns(profile);
    const v = (col: number, slot: number) => cols.get(col)?.[slot] ?? 0;
    const dksNow = await this.readDksActions(profile);

    // what each slot should hold: kind, its extra columns, its sub-layer entries
    type Want = {
      kind: number;
      cols: Map<number, number>;
      dks?: number[];
      subs: Map<number, Entry>;
    };
    const want = new Map<number, Want>();
    const entry = (kc: UiKeycode): Entry => {
      if (!kc) return [0, 0, 0, 0];
      const e = uiToEntry(kc, this.natives);
      if (!e) throw new DriverError('An advanced key uses a keycode this keyboard cannot store.');
      return e;
    };
    for (const ak of keys) {
      const slot = this.slots[ak.key];
      switch (ak.kind) {
        case 'dynamicKeystroke':
          want.set(slot, {
            kind: Kind.DKS,
            cols: new Map([
              [Col.TRAVEL, f.toWire(Col.TRAVEL, ak.bottomOutMm)],
              [
                Col.DKS_START,
                f.toWire(Col.DKS_START, ak.pressMm ?? f.toMm(Col.DKS_START, v(Col.DKS_START, slot)))
              ]
            ]),
            dks: [0, 1, 2, 3].map(i => (ak.keycodes[i] ? stagesToDks(ak.actions[i]) : 0)),
            subs: new Map([0, 1, 2, 3].map(i => [i, entry(ak.keycodes[i] ?? 0)]))
          });
          break;
        case 'tapHold':
          want.set(slot, {
            kind: Kind.MOD_TAP,
            cols: new Map([
              [Col.MT_TIME, Math.min(255, Math.max(1, Math.round(ak.tappingTermMs / 10)))]
            ]),
            subs: new Map([
              [0, entry(ak.hold)],
              [1, entry(ak.tap)]
            ])
          });
          break;
        case 'toggle':
          want.set(slot, {
            kind: ak.repeating ? Kind.TOGGLE_TAP : Kind.TOGGLE_HOLD,
            cols: new Map(),
            subs: new Map([[0, entry(ak.keycode)]])
          });
          break;
        case 'nullBind': {
          const other = this.slots[ak.secondaryKey];
          want.set(slot, {
            kind: Kind.SNAP,
            cols: new Map([[Col.SNAP_PARTNER, other]]),
            subs: new Map()
          });
          want.set(other, {
            kind: Kind.SNAP,
            cols: new Map([[Col.SNAP_PARTNER, slot]]),
            subs: new Map()
          });
          break;
        }
      }
    }

    // sub-layer entries first, as sharkfin does; a key that loses a kind
    // which replaced its own keycode goes back to its factory entry
    const subWrites = [
      new Map<number, Entry>(),
      new Map<number, Entry>(),
      new Map<number, Entry>(),
      new Map<number, Entry>()
    ];
    this.slots.forEach((s, key) => {
      const was = v(Col.MODE, s) & 0x7f;
      const w = want.get(s);
      if (w) for (const [i, e] of w.subs) subWrites[i].set(key, e);
      else if (
        !macroKeys.has(key) &&
        (was === Kind.DKS ||
          was === Kind.MOD_TAP ||
          was === Kind.TOGGLE_HOLD ||
          was === Kind.TOGGLE_TAP)
      )
        subWrites[0].set(
          key,
          this.factory[key] ??
            entryAt(this.keymapCache.get(`${profile}:0:0`) ?? new Uint8Array(512), s)
        );
    });
    for (let i = 0; i < 4; i++)
      if (subWrites[i].size) await this.writeEntries(profile, false, subWrites[i], i);

    // then the switch columns, per key the way sharkfin's switch page writes them
    const next = new Map<number, number[]>([...cols].map(([c, vals]) => [c, [...vals]]));
    const nextDks = dksNow.map(b => [...b]);
    const changed: number[] = [];
    for (const s of this.slots) {
      const was = v(Col.MODE, s) & 0x7f;
      const w = want.get(s);
      const kind =
        w?.kind ??
        (was === Kind.SNAP ||
        was === Kind.DKS ||
        was === Kind.MOD_TAP ||
        was === Kind.TOGGLE_HOLD ||
        was === Kind.TOGGLE_TAP
          ? Kind.NORMAL
          : was);
      let diff = kind !== was;
      next.get(Col.MODE)![s] = (v(Col.MODE, s) & MODE_RAPID_TRIGGER) | kind;
      for (const [col, val] of w?.cols ?? []) {
        if (v(col, s) !== val) diff = true;
        next.get(col)![s] = val;
      }
      if (w?.dks) {
        w.dks.forEach((b, i) => {
          if ((dksNow[i]?.[s] ?? 0) !== b) diff = true;
          nextDks[i][s] = b;
        });
      }
      if (diff) changed.push(s);
    }
    if (!changed.length) {
      this.keymapCache.clear();
      return;
    }
    // a snap pair goes in one visit, at most two keys a visit
    const groups: number[][] = [];
    const done = new Set<number>();
    for (const s of changed) {
      if (done.has(s)) continue;
      const kind = next.get(Col.MODE)![s] & 0x7f;
      const partner = next.get(Col.SNAP_PARTNER)![s];
      const pair =
        kind === Kind.SNAP && changed.includes(partner) && !done.has(partner) ? [s, partner] : [s];
      pair.forEach(x => done.add(x));
      groups.push(pair);
    }
    for (const group of groups) {
      await this.wire.exclusive(async () => {
        const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
        if (cooldown > 0) await this.wire.clock.sleep(cooldown);
        for (const s of group) {
          const kind = next.get(Col.MODE)![s] & 0x7f;
          const list: number[] = [...WRITE_COLUMNS];
          if (kind === Kind.DKS) list.push(Col.DKS_START, Col.DKS_ACTIONS);
          else if (kind === Kind.MOD_TAP) list.push(Col.MT_TIME);
          else if (kind === Kind.SNAP) list.push(Col.SNAP_PARTNER);
          for (const [i, col] of list.entries()) {
            const last = i + 1 === list.length;
            const pkt =
              col === Col.DKS_ACTIONS
                ? f.setDksActions(
                    s,
                    last,
                    nextDks.map(b => b[s] ?? 0)
                  )
                : f.setOne(col, s, last, next.get(col)?.[s] ?? 0);
            if (!pkt) throw new DriverError('slot out of range');
            await this.wire.send(pkt);
          }
          await this.wire.clock.sleep(FLASH_SETTLE_MS);
        }
        this.lastFlash = this.wire.clock.now();
        this.stamp();
      });
    }
    this.columnsCache = { profile, values: next };
    this.dksCache = { profile, blocks: nextDks };
    this.keymapCache.clear();
  }

  /** Macro contents read or written this connection, by slot. */
  private readonly macroCache = new Map<number, Uint8Array>();

  private async macroBlob(slot: number): Promise<Uint8Array> {
    let blob = this.macroCache.get(slot);
    if (!blob) {
      blob = await this.readMacroBlob(slot);
      this.macroCache.set(slot, blob);
    }
    return blob;
  }

  /**
   * Macro keys on both layers: keymap entries `[9, mode, slot, 0]`. Each
   * carries `ryMacroSlot` so an unchanged macro keeps its slot (and any
   * mouse movement, which steps cannot show).
   */
  private async getMacroKeys(profile: number): Promise<AdvancedKey[]> {
    this.macroCache.clear();
    const out: AdvancedKey[] = [];
    for (const layer of [0, 1]) {
      const m = await this.matrix(profile, layer === 1, true);
      for (const [key, s] of this.slots.entries()) {
        const [tag, mode, slot] = entryAt(m, s);
        if (tag !== MACRO_ENTRY_TAG || slot >= RY_MACRO_SLOTS) continue;
        const macro = macroFromBlob(await this.macroBlob(slot));
        out.push({
          kind: 'macro',
          layer,
          key,
          steps: eventsToSteps(macro.events),
          mode: mode === 1 ? 'toggle' : mode === 2 ? 'hold' : macro.repeat > 1 ? 'repeat' : 'once',
          repeat: Math.max(1, Math.min(macro.repeat, 255)),
          ryMacroSlot: slot
        } as AdvancedKey);
      }
    }
    return out;
  }

  private async setMacroKeys(profile: number, keys: readonly AdvancedKey[]): Promise<void> {
    const macros = keys.filter(k => k.kind === 'macro') as ReadonlyArray<
      Extract<AdvancedKey, { kind: 'macro' }> & { ryMacroSlot?: number }
    >;
    const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');

    // each key's macro as a blob; an untouched one keeps its slot's exact bytes
    const wanted: Array<{ ak: (typeof macros)[number]; blob: Uint8Array; id: string }> = [];
    for (const ak of macros) {
      const repeat = ak.mode === 'repeat' ? Math.max(1, ak.repeat) : 1;
      const fresh = macroToBlob({ repeat, events: stepsToEvents(ak.steps) });
      let blob = fresh;
      if (ak.ryMacroSlot !== undefined) {
        const had = await this.macroBlob(ak.ryMacroSlot);
        const was = macroFromBlob(had);
        if (sameSteps(eventsToSteps(was.events), ak.steps) && Math.max(1, was.repeat) === repeat)
          blob = had;
      }
      wanted.push({ ak, blob, id: hex(blob) });
    }

    // slots the other profiles bind are not ours to overwrite
    const others = new Set<number>();
    for (let p = 0; p < this.spec.profiles; p++) {
      if (p === profile) continue;
      for (const fn of [false, true]) {
        const m = await this.matrix(p, fn);
        for (let s = 0; s * 4 < m.length; s++) {
          const e = entryAt(m, s);
          if (e[0] === MACRO_ENTRY_TAG && e[2] < RY_MACRO_SLOTS) others.add(e[2]);
        }
      }
    }

    const slotOf = new Map<string, number>();
    const taken = new Set<number>();
    const hints = new Set(
      macros.map(ak => ak.ryMacroSlot).filter((s): s is number => s !== undefined)
    );
    const writes: Array<{ slot: number; blob: Uint8Array }> = [];
    const place = (id: string, slot: number, blob: Uint8Array) => {
      slotOf.set(id, slot);
      taken.add(slot);
      if (hex(this.macroCache.get(slot) ?? new Uint8Array()) !== id) writes.push({ slot, blob });
    };
    // 1. a slot that already holds exactly this macro
    for (const w of wanted) {
      if (slotOf.has(w.id)) continue;
      const hint = w.ak.ryMacroSlot;
      const same = [hint, ...this.macroCache.keys()].find(
        s =>
          s !== undefined &&
          !taken.has(s) &&
          this.macroCache.get(s) &&
          hex(this.macroCache.get(s)!) === w.id
      );
      if (same !== undefined) place(w.id, same, w.blob);
    }
    // 2. its own old slot, if no other profile uses it; 3. a free slot
    for (const w of wanted) {
      if (slotOf.has(w.id)) continue;
      const hint = w.ak.ryMacroSlot;
      let slot = hint !== undefined && !taken.has(hint) && !others.has(hint) ? hint : -1;
      if (slot < 0) {
        slot =
          [...Array(RY_MACRO_SLOTS).keys()].find(
            s => !taken.has(s) && !others.has(s) && !hints.has(s)
          ) ??
          [...Array(RY_MACRO_SLOTS).keys()].find(s => !taken.has(s) && !others.has(s)) ??
          -1;
      }
      if (slot < 0)
        throw new DriverError(
          `The keyboard holds ${RY_MACRO_SLOTS} macros, and the other profiles use the rest.`
        );
      if (!this.macroCache.has(slot)) await this.macroBlob(slot);
      place(w.id, slot, w.blob);
    }

    for (const { slot, blob } of writes) {
      await this.wire.exclusive(async () => {
        const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
        if (cooldown > 0) await this.wire.clock.sleep(cooldown);
        const pages = macroPages(blob);
        for (let page = 0; page < pages; page++) {
          await this.wire.send(
            macroWritePacket(this.ops.setMacro, slot, page, page + 1 === pages, blob)
          );
          await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
        }
        this.lastFlash = this.wire.clock.now();
        this.stamp();
      });
      this.macroCache.set(slot, blob);
    }

    // bind the keys; a key that lost its macro goes back to its factory entry
    for (const layer of [0, 1]) {
      const fnLayer = layer === 1;
      const m = await this.matrix(profile, fnLayer);
      const next = new Map<number, Entry>();
      this.slots.forEach((s, key) => {
        if (entryAt(m, s)[0] === MACRO_ENTRY_TAG)
          next.set(key, fnLayer ? [0, 0, 0, 0] : (this.factory[key] ?? [0, 0, 0, 0]));
      });
      for (const w of wanted) {
        if (w.ak.layer === layer)
          next.set(w.ak.key, [MACRO_ENTRY_TAG, MODE_CODE[w.ak.mode], slotOf.get(w.id)!, 0]);
      }
      await this.writeEntries(profile, fnLayer, next);
    }
  }

  private async writeEntries(
    profile: number,
    fnLayer: boolean,
    entries: Map<number, Entry>,
    sublayer = 0
  ) {
    const current = await this.matrix(profile, fnLayer, false, sublayer);
    for (const [key, entry] of entries) {
      const slot = this.slots[key];
      if (slot === undefined || sameEntry(entryAt(current, slot), entry)) continue;
      await this.wire.exclusive(async () => {
        await this.gap(KEY_GAP_MS);
        const pkt = keyWritePacket(this.family, profile, slot, entry, fnLayer, sublayer);
        await this.wire.send(pkt);
        this.stamp();
        if (this.family === 'yc500')
          await this.verifyYc500Slot(pkt, profile, slot, entry, fnLayer, sublayer);
      });
      current.set(entry, slot * 4);
    }
  }

  async subscribeTravel(listener: (samples: TravelSample[]) => void): Promise<() => Promise<void>> {
    const f = this.columns;
    if (!f || !this.capabilities.travelStream)
      throw new DriverError('Live travel is read from gen2 boards by cable only.');
    const indexOf = new Map(this.slots.map((slot, index) => [slot, index]));
    const onReport = (event: { reportId: number; data: DataView }) => {
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      const t = parseTravelReport(event.reportId, data);
      if (!t) return;
      const index = indexOf.get(t.slot);
      if (index === undefined) return;
      listener([{ index, raw: t.counts, travelMm: t.counts * f.unitMm }]);
    };
    for (const d of this.streamDevices) {
      if (!d.opened) await d.open();
      d.addEventListener('inputreport', onReport);
    }
    await this.wire.exclusive(async () => {
      await this.gap(SETTING_GAP_MS);
      await this.wire.send(packet(TRAVEL_STREAM, [1]));
      this.stamp();
    });
    return async () => {
      for (const d of this.streamDevices) d.removeEventListener('inputreport', onReport);
      await this.wire.exclusive(async () => {
        await this.gap(SETTING_GAP_MS);
        await this.wire.send(packet(TRAVEL_STREAM, [0]));
        this.stamp();
      });
    };
  }
}

const MODE_CODE = { once: 0, repeat: 0, toggle: 1, hold: 2 } as const;

type Stages = [DksAction, DksAction, DksAction, DksAction];

/**
 * One keycode's action byte (sharkfin dks.ts): four 2-bit cells, one per
 * event (press past the first point, past the second, release past the
 * second, past the first). Read as one tap or one press..release.
 */
export function dksToStages(byte: number): Stages {
  const cells = [0, 1, 2, 3].map(i => (byte >> (2 * i)) & 3);
  const out: Stages = ['hold', 'hold', 'hold', 'hold'];
  for (let i = 0; i < 4; i++) {
    const c = cells[i];
    if (c === 1) {
      out[i] = 'tap';
      return out;
    }
    if (c === 2 || c === 3) {
      let end: number;
      if (c === 2) end = Math.min(i + 1, 3);
      else {
        let j = i;
        while (j < 4 && cells[j] === 3) j++;
        end = Math.min(j < 4 && cells[j] === 2 ? j + 1 : j, 3);
      }
      // a hold that ends where it starts is a tap (sharkfin decodeDks)
      if (end <= i) {
        out[i] = 'tap';
        return out;
      }
      out[i] = 'press';
      out[end] = 'release';
      return out;
    }
  }
  return out;
}

/** The shortest byte for a tap or a press..release (release at the end when none is given). */
export function stagesToDks(stages: readonly DksAction[]): number {
  const tap = stages.indexOf('tap');
  if (tap >= 0) return 1 << (2 * tap);
  const start = stages.indexOf('press');
  if (start < 0) return 0;
  let end = stages.indexOf('release', start + 1);
  if (end < 0) end = 3;
  if (end <= start) return 1 << (2 * start);
  let byte = 0;
  for (let i = start; i < end - 1; i++) byte |= 3 << (2 * i);
  byte |= 2 << (2 * (end - 1));
  return byte;
}

const repeatOf = (ak: Extract<AdvancedKey, { kind: 'macro' }>) =>
  ak.mode === 'repeat' ? Math.max(1, ak.repeat) : 1;

/** Board events as steps; mouse moves have no step form and are left out. */
function eventsToSteps(events: RyMacroEvent[]): MacroStep[] {
  const steps: MacroStep[] = [];
  for (const e of events) {
    if (e.kind === 'move') continue;
    const keycode = e.kind === 'key' ? uiHid(e.usage) : uiMouseButton(e.button + 1);
    steps.push({ keycode, action: e.pressed ? 'press' : 'release', delayMs: e.delayMs });
  }
  return steps;
}

function stepsToEvents(steps: readonly MacroStep[]): RyMacroEvent[] {
  const events: RyMacroEvent[] = [];
  for (const step of steps) {
    const d = decodeUiKeycode(step.keycode);
    const make = (pressed: boolean, delayMs: number): RyMacroEvent => {
      if (d.type === 'hid') return { kind: 'key', usage: d.usage, pressed, delayMs };
      if (d.type === 'mouse' && d.button >= 1 && d.button <= 5)
        return { kind: 'mouse', button: d.button - 1, pressed, delayMs };
      throw new DriverError('A macro step uses a key this keyboard cannot play in a macro.');
    };
    if (step.action === 'tap') events.push(make(true, 0), make(false, step.delayMs));
    else events.push(make(step.action === 'press', step.delayMs));
  }
  return events;
}

const sameSteps = (a: readonly MacroStep[], b: readonly MacroStep[]) =>
  JSON.stringify(stepsToEventsSafe(a)) === JSON.stringify(stepsToEventsSafe(b));

function stepsToEventsSafe(steps: readonly MacroStep[]): RyMacroEvent[] | null {
  try {
    return stepsToEvents(steps);
  } catch {
    return null;
  }
}

/** Effects by wire number (sharkfin lighting-modes.ts). */
const MODE_LABELS: Record<number, string> = {
  1: 'Static',
  2: 'Breathing',
  3: 'Spectrum cycle',
  4: 'Wave',
  5: 'Ripple',
  6: 'Star dots',
  7: 'Flow',
  8: 'Key shadow',
  9: 'Layers',
  10: 'Sine wave',
  11: 'Spring',
  12: 'Neon',
  13: 'Per-key colours',
  14: 'Radiant',
  15: 'Loop',
  16: 'Color grid',
  17: 'Snowfall',
  18: 'Meteor',
  19: 'Silent snow',
  23: 'Train',
  24: 'Endless'
};

const fx = (mode: number, extra: Partial<LightEffect> = {}): LightEffect => ({
  mode,
  label: MODE_LABELS[mode],
  color: true,
  speedMax: 4,
  ...extra
});

/** The common set, for boards without a light table. */
const COMMON_EFFECTS: LightEffect[] = [
  fx(1, { speedMax: null }),
  fx(2),
  fx(3, { color: false }),
  fx(4, { options: ['Right', 'Left', 'Down', 'Up'] }),
  fx(5),
  fx(6),
  fx(7, { options: ['Zigzag', 'Spiral'] }),
  fx(8),
  fx(9),
  fx(10),
  fx(11, { options: ['Outward', 'Inward'] }),
  fx(12, { options: ['Right', 'Left'] }),
  fx(RY_PER_KEY_MODE, { color: false, speedMax: null }),
  fx(14),
  fx(15, { options: ['CCW', 'CW'] }),
  fx(16),
  fx(17),
  fx(18),
  fx(19)
];

const SIDE_EFFECTS: LightEffect[] = [
  { mode: 0, label: 'Off', color: false, speedMax: null },
  { mode: 1, label: 'Static', color: true, speedMax: null },
  { mode: 2, label: 'Breathing', color: true, speedMax: 4 },
  { mode: 3, label: 'Neon', color: false, speedMax: 4 },
  { mode: 4, label: 'Wave', color: true, speedMax: 4 },
  { mode: 5, label: 'Snake', color: true, speedMax: 4 }
];

const toSetting = (p: LedParam): LightSetting => ({
  mode: p.mode,
  speed: p.speed,
  brightness: p.brightness,
  option: p.option,
  rainbow: p.rainbow,
  color: (p.color[0] << 16) | (p.color[1] << 8) | p.color[2]
});

const fromSetting = (s: LightSetting): LedParam => ({
  mode: s.mode,
  speed: s.speed,
  brightness: s.brightness,
  option: s.option,
  rainbow: s.rainbow,
  color: [(s.color >> 16) & 0xff, (s.color >> 8) & 0xff, s.color & 0xff]
});

function sameEntry(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One 512-byte keymap layer, eight raw pages. */
async function readMatrix(
  wire: Wire,
  family: Family,
  profile: number,
  fnLayer: boolean,
  sublayer = 0
): Promise<Uint8Array> {
  const pages: Uint8Array[] = [];
  for (let page = 0; page < KEYMAP_PAGES; page++) {
    pages.push(await wire.readRawPage(keymapReadRequest(family, profile, page, fnLayer, sublayer)));
  }
  return concat(pages);
}

export { WireError };
