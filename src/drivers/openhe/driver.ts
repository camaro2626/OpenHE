/**
 * OpenHE firmware driver: boards running OpenHE's own firmware (libhmk-based,
 * gk68tmr_firmware). The board identifies itself with COMMAND_FIRMWARE_INFO
 * and describes itself (sizes, layout, default keymap) through its metadata,
 * so no per-board registry entry is needed.
 */

import {
  hasCollection,
  InputReportTransport,
  type HidDeviceLike,
  type ReportTransport
} from '../transport';
import {
  DriverError,
  GAMEPAD_BUTTONS,
  type AdvancedKey,
  type BoardLayout,
  type CalibrationSettings,
  type DeviceOptions,
  type SwitchCatalogEntry,
  type SwitchSetup,
  type GamepadButton,
  type GamepadConfig,
  type DeviceInfo,
  type DriverCapabilities,
  type KeyActuation,
  type KeyboardDriver,
  type MacroStep,
  type LayoutKey,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { hmkCodeFromName, hmkLegendFromName, hmkNativeLabel, hmkToUi, uiToHmk } from './keycodes';
import { decodeUiKeycode, uiMomentaryLayer, uiNative } from '../keycodes';
import { OPENHE_SWITCHES, switchByCatalogId } from './switches';
import {
  ACTUATION_CHUNK,
  ACTUATION_SIZE,
  ANALOG_INFO_CHUNK,
  Cmd,
  HMK_USAGE,
  HMK_USAGE_PAGE,
  KEYMAP_CHUNK,
  KEYMAP_GET_CHUNK,
  STAGED_GET_CHUNK,
  STAGED_SET_CHUNK,
  advancedKeySize,
  decodeActuation,
  decodeAdvancedKey,
  encodeActuation,
  encodeAdvancedKey,
  formatFirmwareVersion,
  decodeFirmwareInfo,
  ActFlag,
  CalibrationOp,
  Feature,
  OPENHE_PROTOCOL_VERSION,
  KEY_SWITCH_GET_CHUNK,
  KEY_SWITCH_SET_CHUNK,
  SWITCH_PROFILE_SIZE,
  type HmkSwitchProfile,
  MACRO_NODE_NONE,
  MACRO_NODE_SIZE,
  decodeMacroNode,
  encodeMacroNode,
  type FirmwareInfo,
  gunzipJson,
  rd16,
  rd32,
  request,
  u16,
  u32,
  type HmkMetadata
} from './protocol';

const GAMEPAD_GET_CHUNK = 63;
const GAMEPAD_SET_CHUNK = 60;

/** Advanced keys and the gamepad curve still use 0..255 of full travel. */
const UNITS = 255;

export const OPENHE_HID_FILTER = { usagePage: HMK_USAGE_PAGE, usage: HMK_USAGE } as const;

export function isOpenHEDevice(device: HidDeviceLike): boolean {
  return hasCollection(device, HMK_USAGE_PAGE, HMK_USAGE);
}

export class OpenHEDriver implements KeyboardDriver {
  readonly id = 'openhe' as const;
  /** libhmk KC_TRANSPARENT; an empty slot (KC_NO) does nothing. */
  readonly transparentKeycode = uiNative(0x01);
  /** Full travel of the switches, mm. */
  readonly travelMm: number;
  readonly capabilities: DriverCapabilities;
  readonly layout: BoardLayout;

  private constructor(
    private readonly transport: ReportTransport,
    readonly info: DeviceInfo,
    readonly metadata: HmkMetadata,
    readonly firmware: FirmwareInfo
  ) {
    this.travelMm = firmware.travelCmm / 100;
    if (firmware.features & Feature.GUIDED_CALIBRATION) {
      this.startCalibration = () => this.calibrationCall(CalibrationOp.START).then(() => undefined);
      this.calibrationProgress = () => this.calibrationCall(CalibrationOp.STATE).then(s => s.done);
      this.finishCalibration = () =>
        this.calibrationCall(CalibrationOp.FINISH).then(() => undefined);
    }
    this.capabilities = {
      profiles: metadata.numProfiles,
      layers: metadata.numLayers,
      travelMm: this.travelMm,
      travelStepMm: 0.01,
      actuation: true,
      rapidTrigger: true,
      rapidTriggerSplit: true,
      continuousRapidTrigger: (firmware.features & Feature.CONTINUOUS_RT) !== 0,
      advancedKeys: ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle', 'macro'],
      maxAdvancedKeys: metadata.numAdvancedKeys,
      dynamicKeystrokeBindings: metadata.numDynamicKeystrokeMaxBindings,
      macros: metadata.numMacroNodes > 0,
      travelStream: true,
      calibration: true,
      rgb: false,
      gamepad: (firmware.features & Feature.GAMEPAD) !== 0,
      pollingRates: metadata.usbHighSpeed ? [8000, 1000] : [1000],
      releasePoint: false,
      topDeadzone: (firmware.features & Feature.DEADZONE) !== 0,
      bottomDeadzone: (firmware.features & Feature.DEADZONE) !== 0,
      writable: { keymap: true, actuation: true, advancedKeys: true },
      actuationActiveProfileOnly: false
    };
    this.layout = { ...layoutFromMetadata(metadata), source: 'board' };
  }

  /** Open a WebHID device (already granted by the user) as an OpenHE board. */
  static async fromHidDevice(device: HidDeviceLike): Promise<OpenHEDriver> {
    if (!device.opened) await device.open();
    const transport = new InputReportTransport(device, 0);
    try {
      return await OpenHEDriver.connect(transport, {
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
  ): Promise<OpenHEDriver> {
    const call = (cmd: number, payload: number[] = []) => exchange(transport, cmd, payload);
    const firmware = await call(Cmd.FIRMWARE_INFO)
      .then(decodeFirmwareInfo)
      .catch(() => null);
    if (!firmware) {
      throw new DriverError(
        'This keyboard is not running OpenHE firmware. Flash the OpenHE build for it first.'
      );
    }
    if (firmware.protocolVersion > OPENHE_PROTOCOL_VERSION) {
      throw new DriverError(
        `This keyboard's firmware speaks a newer OpenHE protocol (${firmware.protocolVersion}); update OpenHE.`
      );
    }
    const version = firmware.firmwareVersion;
    const metadata = await readMetadata(transport);
    const serialBytes = (await call(Cmd.GET_SERIAL)).subarray(1, 33);
    const serial = new TextDecoder().decode(serialBytes).replace(/\0.*$/s, '');
    return new OpenHEDriver(
      transport,
      {
        name: metadata.name || usb.productName,
        firmwareVersion: formatFirmwareVersion(version),
        serial: serial || undefined,
        vendorId: usb.vendorId,
        productId: usb.productId
      },
      metadata,
      firmware
    );
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private call(cmd: number, payload: number[] = []): Promise<Uint8Array> {
    return exchange(this.transport, cmd, payload);
  }

  /** 0..255 of full travel (advanced keys, gamepad) to mm. */
  private toMm(units: number): number {
    return (units * this.travelMm) / UNITS;
  }

  private toUnits(mm: number): number {
    return Math.max(0, Math.min(UNITS, Math.round((mm * UNITS) / this.travelMm)));
  }

  /** mm to the firmware's 0.01 mm, clamped to [min, full travel]. */
  private toCmm(mm: number, min = 0): number {
    return Math.max(min, Math.min(Math.round(this.travelMm * 100), Math.round(mm * 100)));
  }

  private checkProfile(profile: number) {
    if (!Number.isInteger(profile) || profile < 0 || profile >= this.metadata.numProfiles) {
      throw new RangeError(`profile ${profile} out of range`);
    }
  }

  async getProfile(): Promise<number> {
    return (await this.call(Cmd.GET_PROFILE))[1];
  }

  async getKeymap(profile: number, layer: number): Promise<UiKeycode[]> {
    this.checkProfile(profile);
    const n = this.metadata.numKeys;
    const out: UiKeycode[] = [];
    for (let offset = 0; offset < n; offset += KEYMAP_GET_CHUNK) {
      const len = Math.min(KEYMAP_GET_CHUNK, n - offset);
      const reply = await this.call(Cmd.GET_KEYMAP, [profile, layer, offset, len]);
      for (let i = 0; i < len; i++) out.push(hmkToUi(reply[1 + i]));
    }
    return out;
  }

  async setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void> {
    this.checkProfile(profile);
    const codes = keymap.map((kc, i) => {
      const code = uiToHmk(kc);
      if (code === null)
        throw new DriverError(`Key ${i}: this keycode is not available on this keyboard`);
      return code;
    });
    if (codes.length !== this.metadata.numKeys)
      throw new RangeError('keymap length does not match the board');
    for (let offset = 0; offset < codes.length; offset += KEYMAP_CHUNK) {
      const chunk = codes.slice(offset, offset + KEYMAP_CHUNK);
      await this.call(Cmd.SET_KEYMAP, [profile, layer, offset, chunk.length, ...chunk]);
    }
  }

  defaultKeymap(layer: number): UiKeycode[] | null {
    const names = this.metadata.defaultKeymaps?.[0]?.[layer];
    if (!names) return null;
    return names.map(name => hmkToUi(hmkCodeFromName(name) ?? 0));
  }

  async getActuation(profile: number): Promise<KeyActuation[]> {
    this.checkProfile(profile);
    const n = this.metadata.numKeys;
    const out: KeyActuation[] = [];
    for (let offset = 0; offset < n; offset += ACTUATION_CHUNK) {
      const len = Math.min(ACTUATION_CHUNK, n - offset);
      const reply = await this.call(Cmd.GET_ACTUATION_MAP, [profile, offset]);
      for (let i = 0; i < len; i++) {
        const a = decodeActuation(reply, 1 + i * ACTUATION_SIZE);
        out.push({
          actuationMm: a.actuation / 100,
          rapidTrigger: (a.flags & ActFlag.RT) !== 0,
          splitSensitivity: (a.flags & ActFlag.SPLIT) !== 0,
          rtPressMm: a.rtPress / 100,
          rtReleaseMm: a.rtRelease / 100,
          continuous: (a.flags & ActFlag.CONTINUOUS) !== 0,
          deadzoneEnabled: (a.flags & ActFlag.DEADZONE) !== 0,
          topDeadzoneMm: a.topDeadzone / 100,
          bottomDeadzoneMm: a.bottomDeadzone / 100
        });
      }
    }
    return out;
  }

  async setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void> {
    this.checkProfile(profile);
    if (actuation.length !== this.metadata.numKeys)
      throw new RangeError('actuation length does not match the board');
    for (let offset = 0; offset < actuation.length; offset += ACTUATION_CHUNK) {
      const chunk = actuation.slice(offset, offset + ACTUATION_CHUNK);
      const bytes = chunk.flatMap(a =>
        encodeActuation({
          // the firmware refuses an actuation point of 0 or past full travel
          actuation: this.toCmm(a.actuationMm, 1),
          rtPress: this.toCmm(a.rtPressMm),
          rtRelease: this.toCmm(a.rtReleaseMm),
          topDeadzone: Math.min(255, this.toCmm(a.topDeadzoneMm)),
          bottomDeadzone: Math.min(255, this.toCmm(a.bottomDeadzoneMm)),
          flags:
            (a.rapidTrigger ? ActFlag.RT : 0) |
            (a.splitSensitivity ? ActFlag.SPLIT : 0) |
            (a.continuous ? ActFlag.CONTINUOUS : 0) |
            (a.deadzoneEnabled ? ActFlag.DEADZONE : 0)
        })
      );
      await this.call(Cmd.SET_ACTUATION_MAP, [profile, offset, chunk.length, ...bytes]);
    }
  }

  private readStaged(cmd: number, profile: number, size: number): Promise<Uint8Array> {
    return readStaged(this.transport, cmd, profile, size);
  }

  async getAdvancedKeys(profile: number): Promise<AdvancedKey[]> {
    this.checkProfile(profile);
    const dks = this.metadata.numDynamicKeystrokeMaxBindings;
    const item = advancedKeySize(dks);
    const bytes = await this.readStaged(
      Cmd.GET_ADVANCED_KEYS,
      profile,
      item * this.metadata.numAdvancedKeys
    );
    const out: AdvancedKey[] = [];
    for (let i = 0; i < this.metadata.numAdvancedKeys; i++) {
      const ak = decodeAdvancedKey(bytes, i * item, dks, u => this.toMm(u));
      if (ak) out.push(ak);
    }
    if (out.some(ak => ak.kind === 'macro') && this.metadata.numMacroNodes > 0) {
      const nodes = await this.readStaged(
        Cmd.GET_MACROS,
        profile,
        MACRO_NODE_SIZE * this.metadata.numMacroNodes
      );
      for (const ak of out) {
        if (ak.kind !== 'macro') continue;
        const withHead = ak as typeof ak & { head?: number };
        ak.steps = this.readMacroChain(nodes, withHead.head ?? MACRO_NODE_NONE);
        delete withHead.head;
      }
    }
    return out;
  }

  /** Follow one macro's linked list of nodes into steps (loops are cut). */
  private readMacroChain(nodes: Uint8Array, head: number): MacroStep[] {
    const steps: MacroStep[] = [];
    const seen = new Set<number>();
    for (let id = head; id !== MACRO_NODE_NONE && id < this.metadata.numMacroNodes;) {
      if (seen.has(id)) break;
      seen.add(id);
      const n = decodeMacroNode(nodes, id * MACRO_NODE_SIZE);
      if (n.action)
        steps.push({ keycode: hmkToUi(n.keycode), action: n.action, delayMs: n.delayMs });
      id = n.next;
    }
    return steps;
  }

  async setAdvancedKeys(profile: number, keys: readonly AdvancedKey[]): Promise<void> {
    this.checkProfile(profile);
    const max = this.metadata.numAdvancedKeys;
    if (keys.length > max) throw new DriverError(`This board holds at most ${max} advanced keys`);
    const dks = this.metadata.numDynamicKeystrokeMaxBindings;
    const item = advancedKeySize(dks);

    // Lay every macro key's steps out in the node table, one linked list each.
    const nodeCount = this.metadata.numMacroNodes;
    const nodes: number[] = [];
    const placed = keys.map(ak => {
      if (ak.kind !== 'macro') return ak;
      if (!ak.steps.length) return { ...ak, head: MACRO_NODE_NONE };
      const head = nodes.length / MACRO_NODE_SIZE;
      if (head + ak.steps.length > nodeCount) {
        throw new DriverError(
          `Macros on this profile need more than the keyboard's ${nodeCount} macro steps. Shorten or remove a macro.`
        );
      }
      ak.steps.forEach((step, i) => {
        const code = uiToHmk(step.keycode);
        if (code === null) {
          throw new DriverError(`A macro step uses a key this keyboard cannot send.`);
        }
        const next = i + 1 < ak.steps.length ? head + i + 1 : MACRO_NODE_NONE;
        nodes.push(...encodeMacroNode(code, step.action, step.delayMs, next));
      });
      return { ...ak, head };
    });

    if (nodeCount > 0 && keys.some(ak => ak.kind === 'macro')) {
      const table = new Uint8Array(nodeCount * MACRO_NODE_SIZE);
      table.set(nodes);
      // unused nodes: action none, next none
      for (let i = nodes.length / MACRO_NODE_SIZE; i < nodeCount; i++) {
        table[i * MACRO_NODE_SIZE + 3] = MACRO_NODE_NONE;
      }
      for (let offset = 0; offset < table.length; offset += STAGED_SET_CHUNK) {
        const chunk = table.subarray(offset, offset + STAGED_SET_CHUNK);
        await this.call(Cmd.SET_MACROS, [profile, ...u16(offset), chunk.length, ...chunk]);
      }
    }

    const bytes = new Uint8Array(item * max);
    placed.forEach((ak, i) =>
      bytes.set(
        encodeAdvancedKey(ak, dks, mm => this.toUnits(mm)),
        i * item
      )
    );
    for (let offset = 0; offset < bytes.length; offset += STAGED_SET_CHUNK) {
      const chunk = bytes.subarray(offset, offset + STAGED_SET_CHUNK);
      await this.call(Cmd.SET_ADVANCED_KEYS, [profile, ...u16(offset), chunk.length, ...chunk]);
    }
  }

  async readTravel(): Promise<TravelSample[]> {
    const n = this.metadata.numKeys;
    const out: TravelSample[] = [];
    for (let offset = 0; offset < n; offset += ANALOG_INFO_CHUNK) {
      const reply = await this.call(Cmd.ANALOG_INFO, [offset]);
      const len = Math.min(ANALOG_INFO_CHUNK, n - offset);
      for (let i = 0; i < len; i++) {
        const o = 1 + i * 4;
        out.push({ index: offset + i, raw: rd16(reply, o), travelMm: rd16(reply, o + 2) / 100 });
      }
    }
    return out;
  }

  supportsKeycode(value: UiKeycode): boolean {
    return uiToHmk(value) !== null;
  }

  keycodeLabel(value: UiKeycode): string | null {
    const d = decodeUiKeycode(value);
    if (d.type === 'native') return hmkNativeLabel(d.code);
    if (d.type === 'layer') return d.layer === 1 ? 'Fn' : `Fn${d.layer}`;
    return null;
  }

  extraKeycodes(): Array<{ value: UiKeycode; label: string }> {
    const out: Array<{ value: UiKeycode; label: string }> = [
      { value: this.transparentKeycode, label: '▽ Transparent' }
    ];
    for (let l = 1; l < this.metadata.numLayers; l++) {
      out.push({ value: uiMomentaryLayer(l), label: `Layer ${l} (hold)` });
    }
    for (let p = 0; p < this.metadata.numProfiles; p++) {
      out.push({ value: uiNative(0xc8 + p), label: `Profile ${p}` });
    }
    for (const code of [0xd0, 0xd1, 0xd2, 0xd3, 0xd4])
      out.push({ value: uiNative(code), label: hmkNativeLabel(code) });
    return out;
  }

  async recalibrate(): Promise<void> {
    await this.call(Cmd.RECALIBRATE);
  }

  /**
   * Guided calibration (firmware feature bit 5): start forgets the learned
   * bottom-outs and takes the rest values with the LEDs off, then the board
   * lights every key blue and each one green once a full press has been
   * learned; finish saves. Present only on firmware that has it.
   */
  startCalibration?: () => Promise<void>;
  calibrationProgress?: () => Promise<boolean[]>;
  finishCalibration?: () => Promise<void>;

  private async calibrationCall(op: number): Promise<{ active: boolean; done: boolean[] }> {
    const r = await this.call(Cmd.CALIBRATION, [op]);
    return {
      active: r[1] === 1,
      done: this.layout.keys.map(k => ((r[2 + (k.index >> 3)] >> (k.index & 7)) & 1) === 1)
    };
  }

  async getGamepad(profile: number): Promise<GamepadConfig> {
    this.checkProfile(profile);
    const n = this.metadata.numKeys;
    const codes: number[] = [];
    for (let offset = 0; offset < n; offset += GAMEPAD_GET_CHUNK) {
      const reply = await this.call(Cmd.GET_GAMEPAD_BUTTONS, [profile, offset]);
      const len = Math.min(GAMEPAD_GET_CHUNK, n - offset);
      codes.push(...reply.subarray(1, 1 + len));
    }
    const o = await this.call(Cmd.GET_GAMEPAD_OPTIONS, [profile]);
    const curve = [0, 1, 2, 3].map(i => ({
      travelMm: this.toMm(o[1 + i * 2]),
      output: o[2 + i * 2] / 255
    }));
    const flags = o[9];
    return {
      buttons: codes.map(c => GAMEPAD_BUTTONS[c] ?? 'none'),
      curve,
      keyboardEnabled: (flags & 1) !== 0,
      gamepadOverride: (flags & 2) !== 0,
      squareJoystick: (flags & 4) !== 0,
      snappyJoystick: (flags & 8) !== 0
    };
  }

  async setGamepad(profile: number, config: GamepadConfig): Promise<void> {
    this.checkProfile(profile);
    if (config.buttons.length !== this.metadata.numKeys) {
      throw new RangeError('gamepad map length does not match the board');
    }
    if (config.curve.length !== 4) throw new RangeError('gamepad curves have exactly 4 points');
    const codes = config.buttons.map((b: GamepadButton) => Math.max(0, GAMEPAD_BUTTONS.indexOf(b)));
    for (let offset = 0; offset < codes.length; offset += GAMEPAD_SET_CHUNK) {
      const chunk = codes.slice(offset, offset + GAMEPAD_SET_CHUNK);
      await this.call(Cmd.SET_GAMEPAD_BUTTONS, [profile, offset, chunk.length, ...chunk]);
    }
    // x must not fall along the curve (xinput.c walks the segments in order)
    const points: number[] = [];
    let lastX = 0;
    for (const p of config.curve) {
      const x = Math.min(255, Math.max(lastX, this.toUnits(p.travelMm)));
      lastX = x;
      points.push(x, Math.min(255, Math.max(0, Math.round(p.output * 255))));
    }
    const flags =
      (config.keyboardEnabled ? 1 : 0) |
      (config.gamepadOverride ? 2 : 0) |
      (config.squareJoystick ? 4 : 0) |
      (config.snappyJoystick ? 8 : 0);
    await this.call(Cmd.SET_GAMEPAD_OPTIONS, [profile, ...points, flags]);
  }

  private get hasSwitchProfiles(): boolean {
    return (this.firmware.features & Feature.SWITCH_PROFILES) !== 0;
  }

  get maxSwitchTypes(): number | undefined {
    return this.hasSwitchProfiles ? 4 : undefined;
  }

  switchCatalog(): SwitchCatalogEntry[] {
    return this.hasSwitchProfiles ? OPENHE_SWITCHES.map(({ catalogId: _, ...s }) => s) : [];
  }

  private async readSwitchProfiles(): Promise<HmkSwitchProfile[]> {
    const r = await this.call(Cmd.GET_SWITCH_PROFILES);
    const n = r[1];
    return Array.from({ length: n }, (_, i) => {
      const o = 2 + i * SWITCH_PROFILE_SIZE;
      return { catalogId: r[o], travelCmm: rd16(r, o + 1), curve: r[o + 3] };
    });
  }

  async getSwitchSetup(): Promise<SwitchSetup> {
    if (!this.hasSwitchProfiles) throw new DriverError('This firmware has no switch profiles.');
    const profiles = await this.readSwitchProfiles();
    const n = this.metadata.numKeys;
    const slots: number[] = [];
    for (let offset = 0; offset < n; offset += KEY_SWITCH_GET_CHUNK) {
      const r = await this.call(Cmd.GET_KEY_SWITCHES, [offset]);
      slots.push(...r.subarray(1, 1 + Math.min(KEY_SWITCH_GET_CHUNK, n - offset)));
    }
    const tuning: SwitchSetup['tuning'] = {};
    const keySwitch = slots.map(slot => {
      const p = profiles[slot] ?? profiles[0];
      const sw = switchByCatalogId(p.catalogId);
      tuning[sw.id] ??= { travelMm: p.travelCmm / 100, curve: p.curve };
      return sw.id;
    });
    return { keySwitch, tuning };
  }

  async setSwitchSetup(setup: SwitchSetup): Promise<void> {
    if (!this.hasSwitchProfiles) throw new DriverError('This firmware has no switch profiles.');
    if (setup.keySwitch.length !== this.metadata.numKeys) {
      throw new RangeError('switch assignment length does not match the board');
    }
    const current = await this.readSwitchProfiles();
    // One firmware profile per switch in use, most-used first so the
    // common switch lands on profile 0 (the one FIRMWARE_INFO reports).
    const counts = new Map<string, number>();
    for (const id of setup.keySwitch) counts.set(id, (counts.get(id) ?? 0) + 1);
    const used = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    if (used.length > current.length) {
      throw new DriverError(`This keyboard can hold ${current.length} different switches at once.`);
    }
    const profiles: HmkSwitchProfile[] = used.map(id => {
      const sw = OPENHE_SWITCHES.find(s => s.id === id);
      if (!sw) throw new DriverError(`Unknown switch "${id}"`);
      const t = setup.tuning[id] ?? { travelMm: sw.travelMm, curve: sw.curve ?? current[0].curve };
      return {
        catalogId: sw.catalogId,
        travelCmm: Math.round(Math.min(10, Math.max(1, t.travelMm)) * 100),
        curve: Math.round(Math.min(250, Math.max(0, t.curve)))
      };
    });
    // unused profiles keep a valid value
    while (profiles.length < current.length) profiles.push({ ...profiles[0] });
    await this.call(Cmd.SET_SWITCH_PROFILES, [
      profiles.length,
      ...profiles.flatMap(p => [p.catalogId, ...u16(p.travelCmm), p.curve])
    ]);
    const slots = setup.keySwitch.map(id => used.indexOf(id));
    for (let offset = 0; offset < slots.length; offset += KEY_SWITCH_SET_CHUNK) {
      const chunk = slots.slice(offset, offset + KEY_SWITCH_SET_CHUNK);
      await this.call(Cmd.SET_KEY_SWITCHES, [offset, chunk.length, ...chunk]);
    }
  }

  async getOptions(): Promise<DeviceOptions> {
    const raw = rd16(await this.call(Cmd.GET_OPTIONS), 1);
    return {
      xinput: (raw & 1) !== 0,
      ...(this.metadata.usbHighSpeed ? { highPollingRate: (raw & 4) !== 0 } : {})
    };
  }

  async setOptions(options: DeviceOptions): Promise<void> {
    // read-modify-write so reserved bits survive
    let raw = rd16(await this.call(Cmd.GET_OPTIONS), 1);
    if (options.xinput !== undefined) raw = options.xinput ? raw | 1 : raw & ~1;
    if (options.highPollingRate !== undefined && this.metadata.usbHighSpeed) {
      raw = options.highPollingRate ? raw | 4 : raw & ~4;
    }
    await this.call(Cmd.SET_OPTIONS, u16(raw & 0xffff));
  }

  async getCalibration(): Promise<CalibrationSettings> {
    const r = await this.call(Cmd.GET_CALIBRATION);
    return { initialRest: rd16(r, 1), initialBottomOutThreshold: rd16(r, 3) };
  }

  async setCalibration(c: CalibrationSettings): Promise<void> {
    const max = (1 << this.metadata.adcResolution) - 1;
    const clamp = (v: number) => Math.min(max, Math.max(0, Math.round(v)));
    await this.call(Cmd.SET_CALIBRATION, [
      ...u16(clamp(c.initialRest)),
      ...u16(clamp(c.initialBottomOutThreshold))
    ]);
  }

  async saveCalibration(): Promise<void> {
    await this.call(Cmd.SAVE_CALIBRATION_THRESHOLD);
  }

  async getTickRate(profile: number): Promise<number> {
    this.checkProfile(profile);
    return (await this.call(Cmd.GET_TICK_RATE, [profile]))[1];
  }

  async setTickRate(profile: number, tickRate: number): Promise<void> {
    this.checkProfile(profile);
    await this.call(Cmd.SET_TICK_RATE, [profile, Math.min(255, Math.max(0, Math.round(tickRate)))]);
  }

  async resetProfile(profile: number): Promise<void> {
    this.checkProfile(profile);
    await this.call(Cmd.RESET_PROFILE, [profile]);
  }

  async duplicateProfile(profile: number, from: number): Promise<void> {
    this.checkProfile(profile);
    this.checkProfile(from);
    if (profile === from) return;
    await this.call(Cmd.DUPLICATE_PROFILE, [profile, from]);
  }

  /** The board resets right after answering; a missing reply is expected. */
  private async fireAndForget(cmd: number) {
    await this.transport.exchange(request(cmd), 300).catch(() => undefined);
  }

  reboot(): Promise<void> {
    return this.fireAndForget(Cmd.REBOOT);
  }

  enterBootloader(): Promise<void> {
    return this.fireAndForget(Cmd.BOOTLOADER);
  }

  async factoryReset(): Promise<void> {
    await this.call(Cmd.FACTORY_RESET);
  }
}

async function exchange(
  transport: ReportTransport,
  cmd: number,
  payload: number[] = []
): Promise<Uint8Array> {
  const reply = await transport.exchange(request(cmd, payload));
  if (reply[0] !== cmd) {
    throw new DriverError(
      reply[0] === Cmd.UNKNOWN
        ? `The keyboard rejected command ${cmd}`
        : `Unexpected reply to command ${cmd}`
    );
  }
  return reply;
}

async function readStaged(transport: ReportTransport, cmd: number, profile: number, size: number) {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size;) {
    const reply = await exchange(transport, cmd, [profile, ...u16(offset)]);
    const len = Math.min(reply[1], STAGED_GET_CHUNK, size - offset);
    if (len === 0) throw new DriverError('Keyboard returned an empty block');
    out.set(reply.subarray(2, 2 + len), offset);
    offset += len;
  }
  return out;
}

async function readMetadata(transport: ReportTransport): Promise<HmkMetadata> {
  const chunks: Uint8Array[] = [];
  let total = -1;
  for (let offset = 0; total < 0 || offset < total;) {
    const reply = await exchange(transport, Cmd.GET_METADATA, u32(offset));
    const remaining = rd32(reply, 1);
    if (total < 0) total = remaining;
    const len = Math.min(remaining, 59);
    if (len === 0) break;
    chunks.push(reply.slice(5, 5 + len));
    offset += len;
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return gunzipJson<HmkMetadata>(bytes);
}

export function layoutFromMetadata(metadata: HmkMetadata): BoardLayout {
  const legends = metadata.defaultKeymaps?.[0]?.[0] ?? [];
  const keys: LayoutKey[] = [];
  let width = 0;
  metadata.layout.keymap.forEach((row, rowIndex) => {
    let x = 0;
    for (const k of row) {
      x += k.x ?? 0;
      const w = k.w ?? 1;
      const h = k.h ?? 1;
      if (!keys.some(existing => existing.index === k.key)) {
        keys.push({
          index: k.key,
          x,
          y: rowIndex + (k.y ?? 0),
          w,
          h,
          label: legends[k.key] ? hmkLegendFromName(legends[k.key]) : String(k.key)
        });
      }
      x += w;
    }
    width = Math.max(width, x);
  });
  keys.sort((a, b) => a.index - b.index);
  const height = keys.reduce((m, k) => Math.max(m, k.y + k.h), 0);
  return { keys, width, height };
}
