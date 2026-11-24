import { useEffect, useMemo, useState } from 'react';
import { REMAP_CATEGORIES, remapLabel } from '../protocol/hero68/remap';
import type { UiKeycode } from '../drivers/keycodes';
import type { KeyboardDriver } from '../drivers/types';
import Hero68Preview from '../components/Hero68Preview';
import type { HeroDeviceModelId } from '../keyboard/devices';
import { indexOfKeyId, keyIdOf } from './boardModel';
import { useKeycodeGroups } from './KeycodePicker';
import { SaveBar } from './SaveBar';

export function keyLabel(driver: KeyboardDriver, value: UiKeycode, fnLayer: boolean): string {
  if (value === 0) return fnLayer ? '▽' : '—';
  const own = driver.keycodeLabel?.(value);
  if (own) return own;
  const label = remapLabel(value);
  return label.startsWith('0x') ? '?' : label.replace(/_/g, ' ');
}

/** Key remapping per layer, with the shared catalog filtered to what the board can store. */
export function RemapPage({
  driver,
  model,
  profile,
  busy,
  run
}: {
  driver: KeyboardDriver;
  model: HeroDeviceModelId;
  profile: number;
  busy: boolean;
  run: (label: string, task: () => Promise<void>) => Promise<boolean>;
}) {
  const [layer, setLayer] = useState(0);
  const [saved, setSaved] = useState<UiKeycode[] | null>(null);
  const [draft, setDraft] = useState<UiKeycode[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [category, setCategory] = useState(REMAP_CATEGORIES[0]?.id ?? '');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null);
    setDraft(null);
    setLoadError(null);
    driver
      .getKeymap(profile, layer)
      .then(map => {
        if (!live) return;
        setSaved(map);
        setDraft([...map]);
      })
      .catch(err => live && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [driver, profile, layer]);

  const groups = useKeycodeGroups(driver);

  const dirty = !!draft && !!saved && draft.some((v, i) => v !== saved[i]);
  const fnLayer = layer > 0;
  const layerNames = Array.from({ length: driver.capabilities.layers }, (_, i) =>
    i === 0
      ? 'Base layer'
      : driver.id === 'rongyuan'
        ? `Layer ${i} (Fn)`
        : driver.id === 'sparklink'
          ? `Fn${i} layer`
          : `Layer ${i}`
  );
  const activeGroup = groups.find(g => g.id === category) ?? groups[0];

  return (
    <div className="drv-page">
      <div className="drv-tabs">
        {layerNames.map((name, i) => (
          <button
            type="button"
            key={name}
            className={`drv-tab${i === layer ? ' is-active' : ''}`}
            disabled={busy || dirty}
            title={dirty ? 'Save or discard changes first' : undefined}
            onClick={() => setLayer(i)}
          >
            {name}
          </button>
        ))}
      </div>
      {loadError && <div className="drv-notice is-error">{loadError}</div>}
      {draft && (
        <section className="keyboard-stage drv-stage">
          <Hero68Preview
            model={model}
            selectedKeys={new Set(selected === null ? [] : [keyIdOf(selected)])}
            onToggleKey={keyId => {
              const i = indexOfKeyId(keyId);
              setSelected(prev => (prev === i ? null : i));
            }}
            keyLabels={Object.fromEntries(
              draft.map((v, i) => [keyIdOf(i), keyLabel(driver, v, fnLayer)])
            )}
            keyClassNames={Object.fromEntries(
              draft.flatMap((v, i) => (v !== saved?.[i] ? [[keyIdOf(i), 'drv-key-changed']] : []))
            )}
          />
        </section>
      )}
      {!draft && !loadError && <div className="drv-notice">Reading keymap…</div>}
      {draft && (
        <div className="drv-picker">
          <div className="drv-picker-head">
            {selected === null ? (
              <span className="drv-muted">Pick a key on the board, then what it should send.</span>
            ) : (
              <span>
                <b>{driver.layout.keys[selected]?.label || `Key ${selected}`}</b> sends{' '}
                <b>{keyLabel(driver, draft[selected], fnLayer)}</b>
              </span>
            )}
            {selected !== null && (
              <span className="drv-toolbar-actions">
                {fnLayer && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setDraft(d => d && d.map((v, i) => (i === selected ? 0 : v)))}
                  >
                    Pass through
                  </button>
                )}
                {!fnLayer && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setDraft(d => d && d.map((v, i) => (i === selected ? 0 : v)))}
                  >
                    Disable
                  </button>
                )}
                {saved && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setDraft(d => d && d.map((v, i) => (i === selected ? saved[i] : v)))
                    }
                  >
                    Restore
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="drv-tabs drv-tabs-small">
            {groups.map(g => (
              <button
                type="button"
                key={g.id}
                className={`drv-tab${g.id === activeGroup?.id ? ' is-active' : ''}`}
                onClick={() => setCategory(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="drv-picker-grid">
            {activeGroup?.actions.map(a => (
              <button
                type="button"
                key={`${activeGroup.id}-${a.value}-${a.label}`}
                className={`drv-pick${selected !== null && draft[selected] === a.value ? ' is-active' : ''}`}
                disabled={selected === null || busy}
                onClick={() => setDraft(d => d && d.map((v, i) => (i === selected ? a.value : v)))}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <SaveBar
        dirty={dirty}
        busy={busy}
        canSave={driver.capabilities.writable.keymap}
        onDiscard={() => saved && setDraft([...saved])}
        onSave={async () => {
          const next = draft!;
          const ok = await run('Writing keymap', () => driver.setKeymap(profile, layer, next));
          if (ok) setSaved([...next]);
        }}
      />
    </div>
  );
}
