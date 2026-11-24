/**
 * Board-neutral driver layer.
 *
 * A driver speaks one keyboard family's protocol (libhmk, RongYuan, AULA ...)
 * and presents it through this interface, so the UI can ask what a board can
 * do (`capabilities`) instead of checking which model is plugged in.
 *
 * Units the UI sees are fixed regardless of the board:
 *  - travel in millimetres (drivers convert to/from their native steps),
 *  - keycodes in the UI keycode space (see `keycodes.ts`),
 *  - keys by index into `layout.keys` (drivers keep their own matrix mapping).
 */

import type { UiKeycode } from './keycodes';

export type DriverId = 'openhe' | 'rongyuan' | 'sparklink' | 'aula-bytetech' | 'aula-xsyd';

/** One physical key in the board's layout, in keycap units. */
export type LayoutKey = {
  /** Index used everywhere else in the driver API. */
  index: number;
  /** Top-left position and size in key units (1U = one standard key). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Short legend, from the default keymap when the board does not give one. */
  label: string;
};

export type BoardLayout = {
  keys: LayoutKey[];
  /**
   * Where the key-to-matrix mapping came from: the board itself, a stored
   * layout matched against the board's keymap, or a plain grid of matrix
   * slots when nothing matched.
   */
  source?: 'board' | 'registry' | 'inferred' | 'grid';
  /** Overall size in key units. */
  width: number;
  height: number;
};

export type AdvancedKeyKind = 'nullBind' | 'dynamicKeystroke' | 'tapHold' | 'toggle' | 'macro';

export type DriverCapabilities = {
  profiles: number;
  layers: number;
  /** Full travel of the switch in millimetres. */
  travelMm: number;
  /** Smallest step the board stores for actuation/RT values, in millimetres. */
  travelStepMm: number;
  actuation: boolean;
  rapidTrigger: boolean;
  /** Separate press and release sensitivities. */
  rapidTriggerSplit: boolean;
  continuousRapidTrigger: boolean;
  advancedKeys: readonly AdvancedKeyKind[];
  maxAdvancedKeys: number;
  /** Keycodes one dynamic keystroke can bind. */
  dynamicKeystrokeBindings: number;
  macros: boolean;
  /** Live per-key travel readout. */
  travelStream: boolean;
  calibration: boolean;
  rgb: boolean;
  gamepad: boolean;
  pollingRates: readonly number[];
  /** Separate release point when rapid trigger is off. */
  releasePoint: boolean;
  topDeadzone: boolean;
  bottomDeadzone: boolean;
  /** Writes the driver will send. Reads always work. */
  writable: { keymap: boolean; actuation: boolean; advancedKeys: boolean };
  /** Whether `getActuation`/`setActuation` work only on the board's active profile. */
  actuationActiveProfileOnly: boolean;
  /** What a board's advanced keys can not do; absent: everything the editor offers. */
  advancedKeyLimits?: AdvancedKeyLimits;
  /** Vendor ranges for the sliders, millimetres. */
  ranges?: Partial<Record<'actuation' | 'rapidTrigger' | 'deadzone', { min: number; max: number }>>;
};

export type NullBindBehavior = Extract<AdvancedKey, { kind: 'nullBind' }>['behavior'];

export type AdvancedKeyLimits = {
  /** Kinds that only exist on the base layer. */
  baseLayerOnly?: AdvancedKeyKind[];
  nullBindBehaviors?: NullBindBehavior[];
  nullBindBottomOut?: boolean;
  /** Each dynamic keystroke keycode does one tap or one press-and-release. */
  dksOneActionPerKeycode?: boolean;
  /** The first point is set per key (`pressMm`) rather than the key's actuation point. */
  dksPressPoint?: boolean;
  /** The second point is the key's own actuation point. */
  dksBottomOutIsActuation?: boolean;
  tapHoldTermMs?: { min: number; max: number; step: number };
  holdOnOtherKeyPress?: boolean;
  /** Toggle's hold time is fixed by the firmware. */
  toggleTermFixedMs?: number;
  /** Toggle can repeat the latched key. */
  toggleRepeat?: boolean;
};

export type DeviceInfo = {
  name: string;
  firmwareVersion: string;
  serial?: string;
  vendorId: number;
  productId: number;
};

/** Per-key actuation settings in board-neutral units. */
/**
 * Per-key actuation in board-neutral units, following OpenAula's model:
 * actuation point; Rapid Trigger on/off with one sensitivity or separate
 * press/release sensitivities; top and bottom dead zones behind one switch.
 * Values a switch turns off are kept, so turning it back on restores them.
 */
export type KeyActuation = {
  actuationMm: number;
  rapidTrigger: boolean;
  /** Separate press and release sensitivities (`capabilities.rapidTriggerSplit`). */
  splitSensitivity: boolean;
  /** Press sensitivity; also the release sensitivity when not split. */
  rtPressMm: number;
  rtReleaseMm: number;
  /** Rapid Trigger resets only at the top (`capabilities.continuousRapidTrigger`). */
  continuous: boolean;
  deadzoneEnabled: boolean;
  /** `capabilities.topDeadzone` */
  topDeadzoneMm: number;
  /** `capabilities.bottomDeadzone` */
  bottomDeadzoneMm: number;
  /** Release point with Rapid Trigger off (`capabilities.releasePoint`, RongYuan). */
  releaseMm?: number;
};

export type TravelSample = {
  index: number;
  /** Raw sensor value, if the board exposes it. */
  raw?: number;
  travelMm: number;
};

export type AdvancedKey =
  | {
      kind: 'nullBind';
      layer: number;
      key: number;
      secondaryKey: number;
      behavior: 'last' | 'primary' | 'secondary' | 'neutral' | 'distance';
      bottomOutMm: number;
    }
  | {
      kind: 'dynamicKeystroke';
      layer: number;
      key: number;
      keycodes: UiKeycode[];
      /** Per keycode, the action at [press, bottom-out, release from bottom-out, release]. */
      actions: Array<[DksAction, DksAction, DksAction, DksAction]>;
      bottomOutMm: number;
      /** First point, where the board sets it per key (`advancedKeyLimits.dksPressPoint`). */
      pressMm?: number;
    }
  | {
      kind: 'tapHold';
      layer: number;
      key: number;
      tap: UiKeycode;
      hold: UiKeycode;
      tappingTermMs: number;
      holdOnOtherKeyPress: boolean;
    }
  | {
      kind: 'toggle';
      layer: number;
      key: number;
      keycode: UiKeycode;
      tappingTermMs: number;
      /** The latched key repeats (`advancedKeyLimits.toggleRepeat`). */
      repeating?: boolean;
    }
  | {
      kind: 'macro';
      layer: number;
      key: number;
      steps: MacroStep[];
      mode: MacroMode;
      /** Plays for mode 'repeat'. */
      repeat: number;
      /** Library macro this came from, when known (not stored on the board). */
      name?: string;
    };

export type MacroMode = 'once' | 'repeat' | 'hold' | 'toggle';

/** One macro step; `delayMs` is the wait after it, before the next step. */
export type MacroStep = {
  keycode: UiKeycode;
  action: 'press' | 'release' | 'tap';
  delayMs: number;
};

export type DksAction = 'hold' | 'press' | 'release' | 'tap';

export const GAMEPAD_BUTTONS = [
  'none',
  'a',
  'b',
  'x',
  'y',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'start',
  'back',
  'home',
  'leftStickClick',
  'rightStickClick',
  'leftBumper',
  'rightBumper',
  'leftStickUp',
  'leftStickDown',
  'leftStickLeft',
  'leftStickRight',
  'rightStickUp',
  'rightStickDown',
  'rightStickLeft',
  'rightStickRight',
  'leftTrigger',
  'rightTrigger'
] as const;
export type GamepadButton = (typeof GAMEPAD_BUTTONS)[number];

/** One point of the analog response: key travel (mm) -> output (0..1). */
export type CurvePoint = { travelMm: number; output: number };

export type GamepadConfig = {
  /** Button per layout key. */
  buttons: GamepadButton[];
  curve: CurvePoint[];
  /** Keys keep typing while the gamepad is on. */
  keyboardEnabled: boolean;
  /** A key mapped to a button stops sending its keyboard keycode. */
  gamepadOverride: boolean;
  squareJoystick: boolean;
  /** Opposite directions take the larger value instead of cancelling. */
  snappyJoystick: boolean;
};

/** Board-wide settings; each field present only where the board has it. */
export type DeviceOptions = {
  /** XInput controller interface (takes effect after the board reconnects). */
  xinput?: boolean;
  /** 8 kHz polling on high-speed USB, 1 kHz otherwise. */
  highPollingRate?: boolean;
  /** Report rate, one of `capabilities.pollingRates`. */
  pollingRateHz?: number;
  /** Key debounce, 1..10 (RongYuan). */
  debounce?: number;
  /** Windows key disabled. */
  winLock?: boolean;
  /** WASD and the arrow keys trade places. */
  wasdSwap?: boolean;
  /** Board picks Windows or macOS layout from the computer. */
  autoOs?: boolean;
  /** Read-only: the board is in macOS mode. */
  macMode?: boolean;
  /** Wireless sleep timeouts in seconds; only the links the board has. */
  sleep?: SleepTimers;
};

export type SleepTimers = {
  /** Light sleep on 2.4 GHz. */
  sleep24?: number;
  sleepBt?: number;
  /** Deep sleep (wakes slower, saves more). */
  deep24?: number;
  deepBt?: number;
};

/** One lighting effect a board offers. */
export type LightEffect = {
  mode: number;
  label: string;
  /** Direction or variant names by option index; null hides one the board lacks. */
  options?: Array<string | null>;
  /** Takes a colour (else always rainbow / its own colours). */
  color: boolean;
  /** Highest speed step, or null when the effect has no speed. */
  speedMax: number | null;
};

export type LightZone = {
  effects: LightEffect[];
  brightnessMax: number;
  /** Mode that means off, when the zone has one (edge light: 0). */
  offMode?: number;
};

/** What a board's lighting can do (`capabilities.rgb`). */
export type LightingInfo = {
  backlight: LightZone;
  /** Edge / side light, where the board has one. */
  side?: LightZone;
  /** Turn the backlight off without losing the effect. */
  canSwitchOff: boolean;
  /** Rainbow and fixed colour can be read the other way round on this board. */
  flagOrder?: { swapped: boolean; fromRegistry: boolean };
};

export type LightSetting = {
  mode: number;
  /** 0 slowest .. speedMax. */
  speed: number;
  brightness: number;
  option: number;
  rainbow: boolean;
  /** 0xRRGGBB */
  color: number;
};

export type LightingState = {
  backlight: LightSetting;
  side?: LightSetting;
  backlightOff?: boolean;
  sideOff?: boolean;
};

export type CalibrationSettings = {
  /** Raw sensor value assumed at rest before a key is calibrated. */
  initialRest: number;
  /** Minimum raw change for a key to count as bottomed out before it has been. */
  initialBottomOutThreshold: number;
};

/** A switch a board can be told a key has. */
export type SwitchCatalogEntry = {
  /** Stable id within this driver. */
  id: string;
  name: string;
  brand: string;
  /** Full travel, mm (default for editable switches). */
  travelMm: number;
  /** Whether travel/curve can be tuned (`SwitchSetup.tuning`). */
  tunable: boolean;
  /** Default travel curve (board-specific meaning) for tunable switches. */
  curve?: number;
};

export type SwitchTuning = { travelMm: number; curve: number };

export type SwitchSetup = {
  /** Catalog id of each layout key's switch. */
  keySwitch: string[];
  /** Travel and curve per tunable catalog id in use. */
  tuning: Record<string, SwitchTuning>;
};

export interface KeyboardDriver {
  readonly id: DriverId;
  readonly info: DeviceInfo;
  readonly capabilities: DriverCapabilities;
  readonly layout: BoardLayout;

  close(): Promise<void>;

  getProfile(): Promise<number>;

  getKeymap(profile: number, layer: number): Promise<UiKeycode[]>;
  setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void>;
  /** Default keymap of a layer, when the board publishes one. */
  defaultKeymap?(layer: number): UiKeycode[] | null;

  getActuation(profile: number): Promise<KeyActuation[]>;
  setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void>;

  getAdvancedKeys?(profile: number): Promise<AdvancedKey[]>;
  setAdvancedKeys?(profile: number, keys: readonly AdvancedKey[]): Promise<void>;

  /** One snapshot of every key's travel. */
  readTravel?(): Promise<TravelSample[]>;
  /** Push-style travel updates; resolves to a stop function. */
  subscribeTravel?(listener: (samples: TravelSample[]) => void): Promise<() => Promise<void>>;

  getGamepad?(profile: number): Promise<GamepadConfig>;
  setGamepad?(profile: number, config: GamepadConfig): Promise<void>;

  /** Switches this board can be told about (Switch Selector). */
  switchCatalog?(): SwitchCatalogEntry[];
  /** How many different switches can be in use at once (OpenHE: 4). */
  maxSwitchTypes?: number;
  getSwitchSetup?(): Promise<SwitchSetup>;
  setSwitchSetup?(setup: SwitchSetup): Promise<void>;

  lightingInfo?(): LightingInfo;
  getLighting?(): Promise<LightingState>;
  setBacklight?(setting: LightSetting): Promise<void>;
  setSideLight?(setting: LightSetting): Promise<void>;
  setLightsOff?(off: { backlightOff?: boolean; sideOff?: boolean }): Promise<void>;
  /** The owner says the board reads rainbow/fixed the other way round. */
  setLightFlagOrder?(swapped: boolean): void;

  getOptions?(): Promise<DeviceOptions>;
  setOptions?(options: DeviceOptions): Promise<void>;

  getCalibration?(): Promise<CalibrationSettings>;
  setCalibration?(calibration: CalibrationSettings): Promise<void>;
  /** Keep the bottom-out values learned so far across reboots. */
  saveCalibration?(): Promise<void>;

  /** Ticks per advanced-key timing step (libhmk tick rate). */
  getTickRate?(profile: number): Promise<number>;
  setTickRate?(profile: number, tickRate: number): Promise<void>;

  resetProfile?(profile: number): Promise<void>;
  duplicateProfile?(profile: number, from: number): Promise<void>;
  reboot?(): Promise<void>;
  enterBootloader?(): Promise<void>;

  /** Label for a keycode only this board knows (driver-native codes). */
  keycodeLabel?(value: UiKeycode): string | null;
  /** Whether the board can store this keycode. */
  supportsKeycode?(value: UiKeycode): boolean;
  /** Keycodes this board offers beyond the shared catalog (layers, profiles ...). */
  extraKeycodes?(): Array<{ value: UiKeycode; label: string }>;

  recalibrate?(): Promise<void>;
  factoryReset?(): Promise<void>;
}

/** Thrown when a board rejects or does not answer a request. */
export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverError';
  }
}
