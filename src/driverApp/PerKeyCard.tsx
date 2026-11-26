/**
 * Per-key colours on the Lighting page: paint keys on the board's own
 * picture and write the pattern. Boards that cannot read their pattern back
 * (RongYuan) get it kept on this computer, per board.
 */

import { useEffect, useMemo, useState } from 'react';
import { Eraser, Paintbrush } from 'lucide-react';
import Hero68Preview from '../components/Hero68Preview';
import RgbColorPicker from '../components/RgbColorPicker';
import type { HeroDeviceModelId } from '../keyboard/devices';
import type { KeyboardDriver, PerKeyLighting } from '../drivers/types';
import { indexOfKeyId, keyIdOf } from './boardModel';
import { SaveBar } from './SaveBar';

type Pattern = Array<number | null>;

const SWATCHES = [0xff0000, 0xff8000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff];
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const fromHex = (h: string) => parseInt(h.replace('#', ''), 16) & 0xffffff;

const storeKey = (driver: KeyboardDriver) =>
  `openhe:per-key:${driver.id}:${driver.info.vendorId}:${driver.info.productId}`;

function loadStored(driver: KeyboardDriver, n: number): Pattern {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(driver)) ?? 'null');
    if (Array.isArray(raw))
      return Array.from({ length: n }, (_, i) => (typeof raw[i] === 'number' ? raw[i] : null));
  } catch {
    // no stored pattern
  }
  return new Array(n).fill(null);
}

function store(driver: KeyboardDriver, p: Pattern) {
  try {
    localStorage.setItem(storeKey(driver), JSON.stringify(p));
  } catch {
    // storage unavailable: the pattern still went to the keyboard
  }
}

/** Keys by legend, for the quick groups. */
function groupOf(driver: KeyboardDriver, legends: string[]): number[] {
  const want = legends.map(l => l.toLowerCase());
  return driver.layout.keys.flatMap((k, i) =>
    want.includes(k.label.trim().toLowerCase().split(/\s+/)[0]) ? [i] : []
  );
}

export function PerKeyCard({
  driver,
  model,
  perKey,
  onWritten
}: {
  driver: KeyboardDriver;
  model: HeroDeviceModelId;
  perKey: PerKeyLighting;
  /** After a write that may have changed the effect. */
  onWritten: () => void;
}) {
  const n = driver.layout.keys.length;
  const [saved, setSaved] = useState<Pattern | null>(null);
  const [draft, setDraft] = useState<Pattern | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [brush, setBrush] = useState(0x00d8ff);
  const [show, setShow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let live = true;
    const done = (p: Pattern) => {
      if (!live) return;
      setSaved(p);
      setDraft(p);
    };
    if (perKey.readable && driver.getPerKeyColors)
      driver
        .getPerKeyColors()
        .then(done)
        .catch(err => live && setError(err instanceof Error ? err.message : String(err)));
    else done(loadStored(driver, n));
    return () => {
      live = false;
    };
  }, [driver, perKey.readable, n]);

  const groups = useMemo(
    () => [
      { name: 'WASD', keys: groupOf(driver, ['w', 'a', 's', 'd']) },
      {
        name: 'Arrows',
        keys: groupOf(driver, ['←', '→', '↑', '↓', 'left', 'right', 'up', 'down'])
      },
      { name: 'All keys', keys: driver.layout.keys.map((_, i) => i) }
    ],
    [driver]
  );

  if (error && !draft) return <div className="drv-notice is-error">{error}</div>;
  if (!draft || !saved) return <div className="drv-notice">Reading per-key colours…</div>;

  const dirty = draft.some((c, i) => c !== saved[i]);
  const set = (c: number | null) => {
    setDraft(d => d && d.map((v, i) => (selected.has(i) ? c : v)));
    setJustSaved(false);
  };
  const frame = Object.fromEntries(
    draft.flatMap((c, i) => (c === null ? [] : [[keyIdOf(i), hex(c)]]))
  );

  return (
    <section className="settings-card drv-per-key">
      <div className="rgb-section-heading">
        <h2>Per-key colours</h2>
        <span>
          {perKey.readable ? 'Read from the keyboard' : 'Kept on this computer for this board'}
        </span>
      </div>
      <p className="rgb-inline-note">
        Select keys on the picture, pick a colour and paint them.{' '}
        {perKey.overlay
          ? 'Painted keys sit on top of any effect; the Per-key colours effect lights only them.'
          : 'The Per-key colours effect shows the pattern; unpainted keys stay dark.'}
        {!perKey.readable &&
          ' The keyboard cannot send its pattern back, so OpenHE remembers the last one you wrote.'}
      </p>
      {error && <div className="drv-notice is-error">{error}</div>}
      <div className="keyboard-stage drv-stage drv-per-key-board">
        <Hero68Preview
          model={model}
          selectedKeys={new Set([...selected].map(keyIdOf))}
          onToggleKey={keyId => {
            const i = indexOfKeyId(keyId);
            setSelected(prev => {
              const next = new Set(prev);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              return next;
            });
          }}
          onSelectKeys={keys => setSelected(new Set([...keys].map(indexOfKeyId)))}
          lightingFrame={frame}
          lightingSource="local"
        />
      </div>
      <div className="rgb-key-paint-tools">
        <div className="rgb-key-paint-selection">
          <span role="status" aria-live="polite">
            {selected.size} / {n} selected
          </span>
          <div role="group" aria-label="Select key group">
            {groups
              .filter(g => g.keys.length)
              .map(g => (
                <button
                  key={g.name}
                  type="button"
                  className="secondary-button"
                  aria-pressed={
                    selected.size === g.keys.length && g.keys.every(i => selected.has(i))
                  }
                  onClick={() => setSelected(new Set(g.keys))}
                >
                  {g.name}
                </button>
              ))}
            <button
              type="button"
              className="secondary-button"
              disabled={!selected.size}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
          </div>
        </div>
        <div className="rgb-key-paint-color">
          <div className="rgb-custom-color-box is-active">
            <label className="rgb-color-picker-trigger" title="Colour">
              <RgbColorPicker
                label="Paint colour"
                value={hex(brush)}
                onChange={h => setBrush(fromHex(h))}
              />
            </label>
            <span className="rgb-color-hex-input">{hex(brush).toUpperCase()}</span>
          </div>
          <div className="rgb-paint-palette" role="group" aria-label="Palette">
            {SWATCHES.map(c => (
              <button
                key={c}
                type="button"
                className="rgb-paint-swatch"
                aria-pressed={brush === c}
                aria-label={hex(c)}
                onClick={() => setBrush(c)}
              >
                <span className="rgb-swatch-dot" style={{ background: hex(c) }} aria-hidden />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="apply-button"
            disabled={!selected.size}
            title={!selected.size ? 'Select keys on the picture to paint.' : undefined}
            onClick={() => set(brush)}
          >
            <Paintbrush size={15} /> Paint keys
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!selected.size}
            onClick={() => set(null)}
          >
            <Eraser size={15} /> Erase
          </button>
        </div>
      </div>
      <label className="drv-toggle-row">
        <span>
          <b>Switch to the Per-key colours effect</b>
          <small className="drv-muted">
            {perKey.overlay
              ? 'Off: painted keys show on top of the current effect.'
              : 'Off: the pattern is stored and shown when you pick that effect.'}
          </small>
        </span>
        <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} />
      </label>
      <SaveBar
        dirty={dirty}
        busy={busy}
        saved={justSaved && !dirty}
        canSave
        onDiscard={() => setDraft(saved)}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await driver.setPerKeyColors!(draft, show);
            if (!perKey.readable) store(driver, draft);
            setSaved(draft);
            setJustSaved(true);
            onWritten();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
