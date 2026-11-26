import { useEffect, useState } from 'react';
import { Toggle } from '../app/components/Toggle';
import type { HeroDeviceModelId } from '../keyboard/devices';
import { GuidedCalibration } from './GuidedCalibration';
import type {
  CalibrationSettings,
  DeviceOptions,
  KeyboardDriver,
  SleepTimers
} from '../drivers/types';

type Run = (label: string, task: () => Promise<void>) => Promise<boolean>;

function Hero({ title, text }: { title: string; text: string }) {
  return (
    <div className="settings-hero general-settings-hero">
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Section({
  title,
  text,
  hint,
  first,
  toggle,
  children
}: {
  title: string;
  text?: string;
  hint?: string;
  first?: boolean;
  toggle?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`device-setting-section${first ? ' first' : ''}${toggle ? ' toggle-setting-section' : ''}`}
    >
      <div className="device-setting-copy">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        {hint && <p className="device-setting-hint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** Polling rate, gamepad interface and advanced-key timing. */
export function GeneralSettingsPage({
  driver,
  profile,
  busy,
  run
}: {
  driver: KeyboardDriver;
  profile: number;
  busy: boolean;
  run: Run;
}) {
  const [options, setOptions] = useState<DeviceOptions | null>(null);
  const [tick, setTick] = useState<number | null>(null);
  const [reconnect, setReconnect] = useState(false);

  useEffect(() => {
    driver
      .getOptions?.()
      .then(setOptions)
      .catch(() => setOptions({}));
  }, [driver]);
  useEffect(() => {
    driver
      .getTickRate?.(profile)
      .then(setTick)
      .catch(() => setTick(null));
  }, [driver, profile]);

  const setOpt = async (patch: DeviceOptions, label: string, needsReconnect = true) => {
    if (await run(label, () => driver.setOptions!(patch))) {
      setOptions(o => ({ ...o, ...patch }));
      if (needsReconnect) setReconnect(true);
    }
  };
  const [debounce, setDebounce] = useState<number | null>(null);
  useEffect(() => setDebounce(options?.debounce ?? null), [options?.debounce]);
  const nothing = !driver.setOptions && !driver.setTickRate;

  return (
    <div className="page settings-page general-device-settings page-enter">
      <Hero
        title="General Settings"
        text={`Device-wide settings for ${driver.info.name}, read from the keyboard.`}
      />
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {nothing && (
            <Section
              first
              title="Nothing to set"
              text="This keyboard has no device-wide settings OpenHE can change yet."
            />
          )}
          {options?.highPollingRate !== undefined && (
            <Section
              first
              title="Polling rate"
              text="How often the keyboard reports to the computer over the cable."
              hint="Takes effect after the keyboard reconnects."
            >
              <div className="device-option-list polling-options">
                {[
                  [true, '8000 Hz', 'Lowest latency'],
                  [false, '1000 Hz', 'Most compatible']
                ].map(([on, label, note]) => (
                  <button
                    type="button"
                    key={String(on)}
                    className={`device-option-row ${options.highPollingRate === on ? 'is-selected' : ''}`}
                    disabled={busy}
                    onClick={() =>
                      setOpt({ highPollingRate: on as boolean }, 'Setting the polling rate')
                    }
                  >
                    <span className="device-radio-dot" aria-hidden="true" />
                    <span>{label as string}</span>
                    <small>{note as string}</small>
                  </button>
                ))}
              </div>
            </Section>
          )}
          {options?.pollingRateHz !== undefined && driver.capabilities.pollingRates.length > 0 && (
            <Section
              first
              title="Report rate"
              text="How often the keyboard reports to the computer. Higher is quicker; a few older games and USB hubs prefer 1000 Hz."
            >
              <div className="device-option-list polling-options">
                {driver.capabilities.pollingRates.map(hz => (
                  <button
                    type="button"
                    key={hz}
                    className={`device-option-row ${options.pollingRateHz === hz ? 'is-selected' : ''}`}
                    disabled={busy}
                    onClick={() => setOpt({ pollingRateHz: hz }, 'Setting the report rate', false)}
                  >
                    <span className="device-radio-dot" aria-hidden="true" />
                    <span>{hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}
          {options?.xinput !== undefined && (
            <Section
              toggle
              title="Gamepad interface"
              text="Adds an Xbox (XInput) controller interface; map keys to it on the Gamepad page."
              hint="Takes effect after the keyboard reconnects."
            >
              <Toggle
                label="Gamepad interface"
                checked={options.xinput}
                disabled={busy}
                onChange={on =>
                  setOpt({ xinput: on }, on ? 'Turning the gamepad on' : 'Turning the gamepad off')
                }
              />
            </Section>
          )}
          {debounce !== null && driver.setOptions && (
            <Section
              title="Debounce"
              text="How long the keyboard waits for a key's signal to settle before it counts. Higher ignores chatter; lower is quicker."
              hint="1 to 10 (the board's own steps)."
            >
              <span className="drv-term">
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={debounce}
                  disabled={busy}
                  aria-label="Debounce"
                  onChange={e => setDebounce(Number(e.target.value))}
                  onPointerUp={() =>
                    debounce !== options?.debounce &&
                    setOpt({ debounce }, 'Setting debounce', false)
                  }
                  onKeyUp={() =>
                    debounce !== options?.debounce &&
                    setOpt({ debounce }, 'Setting debounce', false)
                  }
                />
                <b>{debounce}</b>
              </span>
            </Section>
          )}
          {options?.winLock !== undefined && (
            <Section
              toggle
              title="Windows key lock"
              text="Disables the Windows key, so a game cannot be minimised by a stray press."
            >
              <Toggle
                label="Windows key lock"
                checked={options.winLock}
                disabled={busy}
                onChange={on => setOpt({ winLock: on }, 'Setting the Windows key lock', false)}
              />
            </Section>
          )}
          {options?.wasdSwap !== undefined && (
            <Section
              toggle
              title="WASD and arrows swap"
              text="WASD and the arrow keys trade places."
            >
              <Toggle
                label="WASD and arrows swap"
                checked={options.wasdSwap}
                disabled={busy}
                onChange={on => setOpt({ wasdSwap: on }, 'Swapping WASD and the arrows', false)}
              />
            </Section>
          )}
          {options?.sleep && driver.setOptions && (
            <Section
              title="Wireless sleep"
              text="How long the keyboard waits, unused, before it sleeps on each wireless link. Deep sleep saves more battery but takes longer to wake. Set here over the cable; the keyboard keeps it for wireless use."
              hint="Sleep 1 to 60 minutes; deep sleep 10 to 60 minutes."
            >
              <SleepTimersEditor
                value={options.sleep}
                busy={busy}
                onCommit={sleep => setOpt({ sleep }, 'Setting the sleep timers', false)}
              />
            </Section>
          )}
          {options?.autoOs !== undefined && (
            <Section
              toggle
              title="Detect the computer's system"
              text={`The keyboard switches between its Windows and macOS layouts by itself.${options.macMode !== undefined ? ` Now in ${options.macMode ? 'macOS' : 'Windows'} mode.` : ''}`}
            >
              <Toggle
                label="Detect the computer's system"
                checked={options.autoOs}
                disabled={busy}
                onChange={on => setOpt({ autoOs: on }, 'Setting system detection', false)}
              />
            </Section>
          )}
          {tick !== null && driver.setTickRate && (
            <Section
              title="Advanced key timing"
              text={`Tick rate for profile ${profile + 1}: how many key-scan ticks advanced-key presses and taps wait before they are sent, which is also how long a tap is held. Lower is faster; some games miss very short taps.`}
              hint="Default: 30."
            >
              <span className="drv-term">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={tick}
                  disabled={busy}
                  onChange={e => setTick(Number(e.target.value))}
                />
                <b>{tick}</b>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => run('Saving tick rate', () => driver.setTickRate!(profile, tick))}
                >
                  Apply
                </button>
              </span>
            </Section>
          )}
          {reconnect && driver.reboot && (
            <Section
              toggle
              title="Restart to apply"
              text="Interface and polling changes apply once the keyboard reconnects."
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run('Restarting the keyboard', () => driver.reboot!())}
              >
                Restart keyboard
              </button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Reset or copy on-board profiles. */
export function ProfilesSettingsPage({
  driver,
  profile,
  busy,
  run
}: {
  driver: KeyboardDriver;
  profile: number;
  busy: boolean;
  run: Run;
}) {
  const n = driver.capabilities.profiles;
  const [from, setFrom] = useState(profile === 0 ? Math.min(1, n - 1) : 0);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="page settings-page page-enter">
      <Hero
        title="Profiles"
        text={`${driver.info.name} keeps ${n} profiles on the keyboard. These act on profile ${profile + 1}, the one picked in the sidebar.`}
      />
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {driver.duplicateProfile && n > 1 && (
            <Section
              first
              title={`Copy into profile ${profile + 1}`}
              text="Replaces everything in this profile (keymap, actuation, advanced keys, gamepad) with another profile's."
            >
              <span className="drv-term">
                <select
                  className="drv-select"
                  value={from}
                  onChange={e => setFrom(Number(e.target.value))}
                >
                  {Array.from({ length: n }, (_, i) =>
                    i === profile ? null : (
                      <option key={i} value={i}>
                        From profile {i + 1}
                      </option>
                    )
                  )}
                </select>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    run(`Copying profile ${from + 1}`, () =>
                      driver.duplicateProfile!(profile, from)
                    )
                  }
                >
                  Copy
                </button>
              </span>
            </Section>
          )}
          {driver.resetProfile && (
            <Section
              title={`Reset profile ${profile + 1}`}
              text="Back to the keyboard's defaults for this profile only. Other profiles are not touched."
            >
              {confirm ? (
                <span className="drv-toolbar-actions">
                  <button type="button" className="ghost-button" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="secondary-button is-danger"
                    disabled={busy}
                    onClick={async () => {
                      setConfirm(false);
                      await run(`Resetting profile ${profile + 1}`, () =>
                        driver.resetProfile!(profile)
                      );
                    }}
                  >
                    Reset profile {profile + 1}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirm(true)}
                >
                  Reset…
                </button>
              )}
            </Section>
          )}
          {!driver.resetProfile && !driver.duplicateProfile && (
            <Section
              first
              title="Nothing to manage"
              text="This keyboard does not expose profile copy or reset."
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Calibration starting values, learned values, recalibrate. */
export function CalibrationSettingsPage({
  driver,
  model,
  busy,
  run
}: {
  driver: KeyboardDriver;
  model: HeroDeviceModelId;
  busy: boolean;
  run: Run;
}) {
  const [cal, setCal] = useState<CalibrationSettings | null>(null);
  const [savedCal, setSavedCal] = useState<CalibrationSettings | null>(null);
  useEffect(() => {
    driver
      .getCalibration?.()
      .then(c => {
        setCal(c);
        setSavedCal(c);
      })
      .catch(() => setCal(null));
  }, [driver]);
  const num = (label: string, key: keyof CalibrationSettings, hint: string) =>
    cal && (
      <label className="drv-cal-field">
        <span>{label}</span>
        <input
          type="number"
          min={0}
          max={65535}
          value={cal[key]}
          disabled={busy}
          onChange={e => setCal({ ...cal, [key]: Number(e.target.value) })}
        />
        <small>{hint}</small>
      </label>
    );
  return (
    <div className="page settings-page page-enter">
      <Hero
        title="Calibration"
        text="How the keyboard learns each switch's rest and bottom-out positions."
      />
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {driver.startCalibration && driver.calibrationProgress && driver.finishCalibration && (
            <Section
              first
              title="Calibrate"
              text="The keyboard learns each switch's rest and bottom-out positions while you press every key. Do it after changing switches, or when keys trigger too early or too late."
              hint="Close the vendor's own software first. If you leave this page mid-way, calibration is finished and saved with what the keyboard has learned."
            >
              <GuidedCalibration driver={driver} model={model} busy={busy} />
            </Section>
          )}
          {driver.recalibrate && (
            <Section
              first
              title="Recalibrate"
              text="Takes every key's rest position again and forgets the bottom-out positions learned so far. Release every key first, then press each key all the way down once."
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run('Recalibrating', () => driver.recalibrate!())}
              >
                Recalibrate now
              </button>
            </Section>
          )}
          {driver.saveCalibration && (
            <Section
              title="Keep learned bottom-out positions"
              text="Saves the bottom-out positions learned since the last recalibration, so keys are accurate right after a restart."
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run('Saving calibration', () => driver.saveCalibration!())}
              >
                Save current positions
              </button>
            </Section>
          )}
          {cal && driver.setCalibration && (
            <Section
              title="Starting values"
              text="Raw sensor values used before a key has been calibrated, and after a recalibration."
              hint="Raise the bottom-out threshold if keys register full travel too early after a recalibration; lower it if they never reach the bottom."
            >
              <div className="drv-cal-grid">
                {num(
                  'Initial rest value',
                  'initialRest',
                  'Set above the real rest reading so calibration settles on the real one.'
                )}
                {num(
                  'Initial bottom-out threshold',
                  'initialBottomOutThreshold',
                  'Raw change from rest that counts as fully pressed.'
                )}
              </div>
              <span className="drv-toolbar-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy || JSON.stringify(cal) === JSON.stringify(savedCal)}
                  onClick={() => setCal(savedCal)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || JSON.stringify(cal) === JSON.stringify(savedCal)}
                  onClick={async () => {
                    if (await run('Saving starting values', () => driver.setCalibration!(cal)))
                      setSavedCal(cal);
                  }}
                >
                  Save
                </button>
              </span>
            </Section>
          )}
          {!driver.recalibrate && !driver.setCalibration && !driver.startCalibration && (
            <Section
              first
              title="Not available"
              text="This keyboard calibrates itself; there is nothing to set here."
            />
          )}
        </div>
      </div>
    </div>
  );
}

const SLEEP_ROWS = [
  ['sleep24', 'Sleep · 2.4 GHz', 60],
  ['sleepBt', 'Sleep · Bluetooth', 60],
  ['deep24', 'Deep sleep · 2.4 GHz', 600],
  ['deepBt', 'Deep sleep · Bluetooth', 600]
] as const;
const SLEEP_MAX_S = 3600;

function SleepTimersEditor({
  value,
  busy,
  onCommit
}: {
  value: SleepTimers;
  busy: boolean;
  onCommit: (next: SleepTimers) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="drv-sleep-grid">
      {SLEEP_ROWS.filter(([key]) => draft[key] !== undefined).map(([key, label, min]) => {
        const seconds = Math.min(SLEEP_MAX_S, Math.max(draft[key] ?? min, min));
        const commit = () => {
          if (draft[key] !== value[key]) onCommit({ ...value, [key]: seconds });
        };
        return (
          <label key={key} className="drv-field">
            <span>{label}</span>
            <span className="drv-term">
              <input
                type="range"
                min={min}
                max={SLEEP_MAX_S}
                step={60}
                value={seconds}
                disabled={busy}
                aria-label={label}
                onChange={e => setDraft(d => ({ ...d, [key]: Number(e.target.value) }))}
                onPointerUp={commit}
                onKeyUp={commit}
              />
              <b>{Math.round(seconds / 60)} min</b>
            </span>
          </label>
        );
      })}
    </div>
  );
}
