/**
 * OpenAula's Switch Selector on a driver board: pick keys, pick the switch
 * they have. On OpenHE firmware each switch's travel and curve can be tuned
 * (they set how the board turns sensor readings into millimetres); on
 * RongYuan boards the vendor's switch models are written as they are.
 */

import { useMemo, useState } from 'react';
import { RangeControl } from '../app/components/RangeControl';
import type { KeyboardDriver } from '../drivers/types';
import type { HeroDeviceModelId } from '../keyboard/devices';
import { SwitchSelectorPage } from '../pages/SwitchSelectorPage';
import { indexOfKeyId, keyIdOf } from './boardModel';
import { SaveBar } from './SaveBar';
import { catalogIdOf, switchOptionId, type SwitchSetupState } from './useSwitchSetup';

type Run = (label: string, task: () => Promise<void>) => Promise<boolean>;

export function SwitchesPage({
  driver,
  model,
  sw,
  busy,
  run
}: {
  driver: KeyboardDriver;
  model: HeroDeviceModelId;
  sw: SwitchSetupState;
  busy: boolean;
  run: Run;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('all');
  const [justSaved, setJustSaved] = useState(false);
  const keyIds = useMemo(() => driver.layout.keys.map(k => keyIdOf(k.index)), [driver]);

  const draft = sw.draft;
  const selectedIds = [...selected].map(id => draft?.keySwitch[indexOfKeyId(id)]);
  const firstId = selectedIds[0] ?? draft?.keySwitch[0];
  const mixed = selectedIds.some(id => id !== selectedIds[0]);
  const selectedOption =
    sw.options.find(o => o.id === switchOptionId(firstId ?? '')) ?? sw.options[0];
  const current = sw.catalog.find(c => c.id === catalogIdOf(selectedOption?.id ?? ''));
  const tuning = current && draft ? draft.tuning[current.id] : undefined;
  const inUse = new Set(draft?.keySwitch ?? []);
  const limit = driver.maxSwitchTypes;

  if (sw.error) return <div className="drv-notice is-error">{sw.error}</div>;
  if (!draft || !selectedOption) return <div className="drv-notice">Reading switches…</div>;

  const save = async () => {
    const next = draft;
    const ok = await run('Writing switches', () => driver.setSwitchSetup!(next));
    if (ok) {
      sw.setSaved(structuredClone(next));
      setJustSaved(true);
    }
  };

  return (
    <div className="drv-openaula drv-switches">
      <SwitchSelectorPage
        model={model}
        selectedKeys={selected}
        hasSelection={selected.size > 0}
        allSelected={selected.size === keyIds.length}
        onToggleKey={id =>
          setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onSelectKeys={keys => setSelected(new Set(keys))}
        onSelectAll={() => setSelected(new Set(keyIds))}
        onDiscardSelection={() => setSelected(new Set())}
        switchPreviewByKey={Object.fromEntries(
          draft.keySwitch.flatMap((id, i) => {
            const top = sw.options.find(o => o.id === switchOptionId(id))?.top;
            return top ? [[keyIdOf(i), top]] : [];
          })
        )}
        selectedSwitch={selectedOption}
        switchProfileMixed={mixed}
        onAssignSwitchProfile={optionId => {
          const id = catalogIdOf(optionId);
          const next = draft.keySwitch.map((v, i) => (selected.has(keyIdOf(i)) ? id : v));
          if (limit && new Set(next).size > limit) {
            void run('Assigning switch', async () => {
              throw new Error(`This keyboard can hold ${limit} different switches at once.`);
            });
            return;
          }
          const entry = sw.catalog.find(c => c.id === id);
          setJustSaved(false);
          sw.setDraft({
            keySwitch: next,
            tuning:
              entry?.tunable && !draft.tuning[id]
                ? {
                    ...draft.tuning,
                    [id]: {
                      travelMm: entry.travelMm,
                      curve: entry.curve ?? Object.values(draft.tuning)[0]?.curve ?? 0
                    }
                  }
                : draft.tuning
          });
        }}
        switchSearch={search}
        onSwitchSearchChange={setSearch}
        switchBrandFilter={brand}
        onSwitchBrandFilterChange={setBrand}
        canSave={sw.dirty}
        profileBusy={busy}
        saveState={justSaved && !sw.dirty ? 'sent' : 'idle'}
        onSave={() => void save()}
      >
        {current?.tunable && tuning && inUse.has(current.id) && (
          <section className="switch-assignment-grid">
            <article className="settings-card switch-assignment-card drv-switch-tuning">
              <div className="settings-card-head">
                <h2>{current.name}: travel and curve</h2>
                <p>
                  Apply to every key with this switch. Travel is the switch's full stroke; the curve
                  shapes how sensor readings turn into millimetres (0 = linear, higher bends the top
                  of the stroke). Set travel from the switch's spec sheet, then check with Hall
                  Stream that a full press reads the full travel.
                </p>
              </div>
              <div className="drv-field">
                <div className="drv-field-head">
                  <span>Full travel</span>
                </div>
                <RangeControl
                  value={tuning.travelMm}
                  min={1}
                  max={6}
                  step={0.01}
                  suffix="mm"
                  disabled={busy}
                  onChange={v =>
                    sw.setDraft({
                      ...draft,
                      tuning: { ...draft.tuning, [current.id]: { ...tuning, travelMm: v } }
                    })
                  }
                />
              </div>
              <div className="drv-field">
                <div className="drv-field-head">
                  <span>Travel curve</span>
                  <small>{(tuning.curve / 10).toFixed(1)} (0 = linear)</small>
                </div>
                <input
                  type="range"
                  className="drv-curve-range"
                  min={0}
                  max={100}
                  step={1}
                  value={tuning.curve}
                  disabled={busy}
                  onChange={e =>
                    sw.setDraft({
                      ...draft,
                      tuning: {
                        ...draft.tuning,
                        [current.id]: { ...tuning, curve: Number(e.target.value) }
                      }
                    })
                  }
                />
              </div>
              {limit && (
                <p className="drv-muted">
                  {inUse.size} of {limit} switch types in use on this keyboard.
                </p>
              )}
            </article>
          </section>
        )}
      </SwitchSelectorPage>

      <SaveBar
        dirty={sw.dirty}
        busy={busy}
        saved={justSaved && !sw.dirty}
        canSave={!!driver.setSwitchSetup}
        onDiscard={() => sw.saved && sw.setDraft(structuredClone(sw.saved))}
        onSave={() => void save()}
      />
    </div>
  );
}
