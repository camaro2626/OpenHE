/**
 * Lighting for boards whose driver has `lightingInfo` (RongYuan, Sparklink): effect,
 * brightness, speed, direction and colour for the backlight and the edge
 * light, in OpenAula's RGB page layout. Each change is written to the board
 * shortly after you stop dragging (lighting is stored in flash).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Lightbulb, Palette, Power, Sparkles, Waves } from 'lucide-react';
import RgbColorPicker from '../components/RgbColorPicker';
import '../components/RgbSettingsPage.css';
import type {
  KeyboardDriver,
  LightingInfo,
  LightingState,
  LightSetting,
  LightZone
} from '../drivers/types';

type Zone = 'backlight' | 'side';

const SWATCHES = [
  ['Red', 0xff0000],
  ['Orange', 0xff8000],
  ['Yellow', 0xffff00],
  ['Green', 0x00ff00],
  ['Cyan', 0x00ffff],
  ['Blue', 0x0000ff],
  ['Magenta', 0xff00ff],
  ['White', 0xffffff]
] as const;

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const fromHex = (h: string) => parseInt(h.replace('#', ''), 16) & 0xffffff;
/** Wait after the last change before writing (the board takes one write a second). */
const WRITE_DELAY_MS = 350;

export function LightingPage({ driver }: { driver: KeyboardDriver }) {
  const [info, setInfo] = useState<LightingInfo | null>(() => driver.lightingInfo?.() ?? null);
  const [state, setState] = useState<LightingState | null>(null);
  const [zone, setZone] = useState<Zone>('backlight');
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const pending = useRef<{ zone: Zone; setting: LightSetting } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(() => {
    setError(null);
    driver
      .getLighting?.()
      .then(setState)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [driver]);
  useEffect(load, [load]);

  // one write in flight at a time; only the latest pending setting is sent
  const flush = useCallback(() => {
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    chain.current = chain.current.then(async () => {
      setWriting(true);
      try {
        if (next.zone === 'side') await driver.setSideLight!(next.setting);
        else await driver.setBacklight!(next.setting);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setWriting(false);
      }
    });
  }, [driver]);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    },
    [flush]
  );

  if (!info || !driver.getLighting) {
    return <div className="drv-notice">This board's lighting is not supported yet.</div>;
  }
  if (!state) {
    return error ? (
      <div className="drv-notice is-error">{error}</div>
    ) : (
      <div className="drv-notice">Reading lighting…</div>
    );
  }

  const zoneInfo: LightZone = zone === 'side' && info.side ? info.side : info.backlight;
  const setting = (zone === 'side' ? state.side : state.backlight) ?? state.backlight;
  const effect = zoneInfo.effects.find(e => e.mode === setting.mode);
  const off = zone === 'side' ? state.sideOff : state.backlightOff;

  const change = (patch: Partial<LightSetting>) => {
    const next = { ...setting, ...patch };
    setState(s => (s ? { ...s, [zone]: next } : s));
    pending.current = { zone, setting: next };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, WRITE_DELAY_MS);
  };

  const setOff = (value: boolean) => {
    const patch = zone === 'side' ? { sideOff: value } : { backlightOff: value };
    setState(s => (s ? { ...s, ...patch } : s));
    chain.current = chain.current.then(async () => {
      setWriting(true);
      try {
        await driver.setLightsOff!(patch);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setWriting(false);
      }
    });
  };

  const speedMax = effect?.speedMax ?? null;
  const options = effect?.options?.map((o, i) => ({ o, i })).filter(({ o }) => o !== null) ?? [];
  const usesColor = !!effect?.color;
  const isOffMode = zoneInfo.offMode !== undefined && setting.mode === zoneInfo.offMode;

  return (
    <div className="page settings-page rgb-settings-page page-enter drv-lighting">
      <header className="rgb-page-heading">
        <h1>Lighting</h1>
        <span className="drv-muted">
          {writing ? 'Writing to the keyboard…' : 'Changes are written to the keyboard as you go.'}
        </span>
      </header>
      {error && <div className="drv-notice is-error">{error}</div>}
      <div className="rgb-editor-layout">
        <aside className="settings-card rgb-effect-library">
          {info.side && (
            <div className="rgb-zone-tabs" role="group" aria-label="Lighting zone">
              {(['backlight', 'side'] as const).map(id => (
                <button key={id} aria-pressed={zone === id} onClick={() => setZone(id)}>
                  {id === 'backlight' ? 'Keys' : 'Edge light'}
                </button>
              ))}
            </div>
          )}
          <h2>Choose effect</h2>
          <div className="rgb-mode-grid">
            {zoneInfo.effects.map((e, i) => {
              const Icon =
                e.mode === zoneInfo.offMode ? Power : [Lightbulb, Waves, Sparkles, Palette][i % 4];
              return (
                <button
                  key={e.mode}
                  className={setting.mode === e.mode ? 'active' : ''}
                  aria-pressed={setting.mode === e.mode}
                  onClick={() =>
                    change({
                      mode: e.mode,
                      option: e.options ? Math.min(setting.option, e.options.length - 1) : 0,
                      speed: Math.min(setting.speed, e.speedMax ?? 4)
                    })
                  }
                >
                  <Icon size={16} />
                  <span>{e.label}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="settings-card rgb-basic-card">
          <div className="rgb-section-heading">
            <h2>{effect?.label ?? `Effect ${setting.mode}`}</h2>
            <span>{zone === 'side' ? 'Edge light' : 'Key lighting'}</span>
          </div>
          {!effect && (
            <p className="rgb-inline-note">
              The keyboard is on effect {setting.mode}, which OpenHE does not list for this board.
              It is kept until you pick another.
            </p>
          )}
          {info.canSwitchOff && (zone === 'backlight' || info.side) && (
            <label className="drv-toggle-row">
              <span>
                <b>{zone === 'side' ? 'Edge light off' : 'Backlight off'}</b>
                <small className="drv-muted">Keeps the effect for when you turn it back on.</small>
              </span>
              <input type="checkbox" checked={!!off} onChange={e => setOff(e.target.checked)} />
            </label>
          )}
          {!isOffMode && (
            <div className="rgb-parameters">
              <label>
                Brightness{' '}
                <strong>
                  {zoneInfo.percent
                    ? `${setting.brightness}%`
                    : `${setting.brightness} / ${zoneInfo.brightnessMax}`}
                </strong>
                <input
                  aria-label="Brightness"
                  type="range"
                  min={0}
                  max={zoneInfo.brightnessMax}
                  value={Math.min(setting.brightness, zoneInfo.brightnessMax)}
                  onChange={e => change({ brightness: Number(e.target.value) })}
                />
              </label>
              {speedMax !== null && (
                <label>
                  Speed{' '}
                  <strong>
                    {zoneInfo.percent
                      ? `${setting.speed}%`
                      : `${setting.speed + 1} / ${speedMax + 1}`}
                  </strong>
                  <input
                    aria-label="Speed"
                    type="range"
                    min={0}
                    max={speedMax}
                    value={Math.min(setting.speed, speedMax)}
                    onChange={e => change({ speed: Number(e.target.value) })}
                  />
                </label>
              )}
              {options.length > 1 && (
                <div className="rgb-zone-tabs" role="group" aria-label="Direction">
                  {options.map(({ o, i }) => (
                    <button
                      key={i}
                      aria-pressed={setting.option === i}
                      onClick={() => change({ option: i })}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              {usesColor && (
                <div className="rgb-color-controls">
                  <div className="rgb-color-header">
                    <span className="rgb-color-label">Color</span>
                    <div
                      className={`rgb-custom-color-box ${setting.rainbow ? 'is-multicolor' : 'is-custom-active'}`}
                    >
                      <label className="rgb-color-picker-trigger" title="Effect color">
                        <RgbColorPicker
                          label="Effect color"
                          value={hex(setting.color)}
                          onChange={h => change({ color: fromHex(h), rainbow: false })}
                        />
                      </label>
                      <span className="rgb-color-hex-input">
                        {hex(setting.color).toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="rgb-swatch-grid" role="group" aria-label="Color">
                    <button
                      type="button"
                      className="rgb-swatch-chip is-multicolor"
                      aria-pressed={setting.rainbow}
                      onClick={() => change({ rainbow: true })}
                    >
                      <span className="rgb-swatch-dot is-rainbow" aria-hidden="true" />
                      <span className="rgb-swatch-name">Rainbow</span>
                    </button>
                    {SWATCHES.map(([name, c]) => (
                      <button
                        key={name}
                        type="button"
                        className="rgb-swatch-chip"
                        aria-pressed={!setting.rainbow && setting.color === c}
                        onClick={() => change({ color: c, rainbow: false })}
                      >
                        <span
                          className="rgb-swatch-dot"
                          style={{ background: hex(c) }}
                          aria-hidden="true"
                        />
                        <span className="rgb-swatch-name">{name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {info.flagOrder && driver.setLightFlagOrder && (
            <details className="drv-details">
              <summary>Rainbow and solid colour swapped?</summary>
              <p className="drv-muted">
                Some RongYuan firmware reads the rainbow and solid-colour flag the other way round.
                If picking Rainbow gives a solid colour (or the reverse), flip this.
                {info.flagOrder.fromRegistry
                  ? ' This board uses the board list’s setting.'
                  : ' This board uses your setting.'}
              </p>
              <label className="drv-toggle-row">
                <span>
                  <b>Swapped flag order</b>
                </span>
                <input
                  type="checkbox"
                  checked={info.flagOrder.swapped}
                  onChange={e => {
                    driver.setLightFlagOrder!(e.target.checked);
                    setInfo(driver.lightingInfo!());
                    change({});
                  }}
                />
              </label>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}
