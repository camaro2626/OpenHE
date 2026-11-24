import { RangeControl } from '../app/components/RangeControl';
/**
 * OpenAula's own Quick Settings, Actuation Point, Rapid Trigger and Hall
 * Stream pages on a driver board. The pages are OpenAula's components, fed
 * from OpenHE's actuation draft (usePerformance) and live travel
 * (useDriverHall); only the save bar and a few OpenHE-only extras are added.
 */

import { useMemo, useState } from 'react';
import { Toggle } from '../app/components/Toggle';
import { switchOptionsForModel, type SwitchOption } from '../app/switchAssets';
import type { KeyboardDriver } from '../drivers/types';
import { ActuationPage } from '../pages/ActuationPage';
import { QuickSettingsPage } from '../pages/QuickSettingsPage';
import { RapidPage } from '../pages/RapidPage';
import { StreamPage } from '../pages/StreamPage';
import { HERO68_HALL_VISUAL_MAX_MM } from '../protocol/hero68/hallStream';
import type { ActuationDraft } from './actuationDraft';
import { SaveBar } from './SaveBar';
import type { OpenAulaPerformance } from './usePerformance';
import type { useDriverHall } from './useDriverHall';
import type { SwitchSetupState } from './useSwitchSetup';
import { indexOfKeyId } from './boardModel';

type Run = (label: string, task: () => Promise<void>) => Promise<boolean>;
type Hall = ReturnType<typeof useDriverHall>;

type Props = {
  driver: KeyboardDriver;
  profile: number;
  state: ActuationDraft;
  perf: OpenAulaPerformance;
  busy: boolean;
  run: Run;
};

/** The switch the travel picture shows: the selected keys' switch when the board knows it. */
function useSwitch(
  driver: KeyboardDriver,
  perf?: OpenAulaPerformance,
  sw?: SwitchSetupState
): { option: SwitchOption; mixed: boolean } {
  const generic = useMemo(() => {
    const base = switchOptionsForModel('hero68')[0];
    return {
      ...base,
      name: 'Magnetic',
      fullName: `${driver.info.name} switches`,
      brand: driver.info.name,
      note: `${driver.capabilities.travelMm.toFixed(1)} mm travel`,
      travelMm: driver.capabilities.travelMm
    };
  }, [driver]);
  if (!sw?.draft || !perf) return { option: generic, mixed: false };
  const keys = perf.selectedKeys.size ? [...perf.selectedKeys] : [];
  const options = keys.map(id => sw.optionOfKey(indexOfKeyId(id)));
  const first = options[0] ?? sw.optionOfKey(0);
  return {
    option: first ?? generic,
    mixed: options.some(o => o?.id !== options[0]?.id)
  };
}

function ActuationSave({ driver, profile, state, busy, run }: Omit<Props, 'perf'>) {
  const [justSaved, setJustSaved] = useState(false);
  const readOnly = !driver.capabilities.writable.actuation;
  return (
    <SaveBar
      dirty={state.dirty}
      busy={busy}
      saved={justSaved && !state.dirty}
      canSave={!readOnly}
      title={
        readOnly ? 'Switch settings on this keyboard can be read but not written yet' : undefined
      }
      onDiscard={() => state.saved && state.setDraft(state.saved.map(k => ({ ...k })))}
      onSave={async () => {
        const next = state.draft;
        if (!next) return;
        const ok = await run('Writing switch settings', () => driver.setActuation(profile, next));
        if (ok) {
          state.markSaved(next);
          setJustSaved(true);
        }
      }}
    />
  );
}

/** Wrapper classes hide controls the board does not have (e.g. top dead zone on RongYuan). */
function capClasses(driver: KeyboardDriver) {
  const c = driver.capabilities;
  return [
    'drv-openaula',
    c.topDeadzone ? '' : 'no-top-deadzone',
    c.bottomDeadzone ? '' : 'no-bottom-deadzone',
    c.topDeadzone || c.bottomDeadzone ? '' : 'no-deadzone',
    c.rapidTriggerSplit ? '' : 'no-split'
  ].join(' ');
}

function Loading({ state }: { state: ActuationDraft }) {
  if (state.error) return <div className="drv-notice is-error">{state.error}</div>;
  return <div className="drv-notice">Reading switch settings…</div>;
}

function ReadOnlyNotice({ driver }: { driver: KeyboardDriver }) {
  if (driver.capabilities.writable.actuation) return null;
  return (
    <div className="drv-notice drv-openaula-notice">
      This keyboard's switch settings can be read but not written yet: writes are enabled only for
      firmware lines whose write path has been verified.
    </div>
  );
}

function perfPageProps(perf: OpenAulaPerformance) {
  return {
    model: perf.model,
    advancedBindings: [],
    selectedKeys: perf.selectedKeys,
    toggleKey: perf.toggleKey,
    onSelectKeys: perf.onSelectKeys,
    quickPreviewMode: perf.quickPreviewMode,
    setQuickPreviewMode: perf.setQuickPreviewMode,
    rapidPreviewByKey: perf.rapidPreviewByKey,
    deadzonePreviewByKey: perf.deadzonePreviewByKey,
    hasSelection: perf.hasSelection,
    allSelected: perf.allSelected,
    selectAll: perf.selectAll,
    discardSelection: perf.discardSelection,
    rapidTrigger: perf.rapidTrigger,
    rapidTriggerMixed: perf.rapidTriggerMixed,
    setRapidTriggerForSelection: perf.setRapidTriggerForSelection,
    rapidTriggerControlsEnabled: perf.rapidTriggerControlsEnabled,
    splitSensitivity: perf.splitSensitivity,
    splitSensitivityMixed: perf.splitSensitivityMixed,
    setSplitSensitivityForSelection: perf.setSplitSensitivityForSelection,
    splitSensitivityControlsEnabled: perf.splitSensitivityControlsEnabled,
    rapidSensitivity: perf.rapidSensitivity,
    rapidSensitivityMixed: perf.rapidSensitivityMixed,
    setRapidSensitivityForSelection: perf.setRapidSensitivityForSelection,
    pressSensitivity: perf.pressSensitivity,
    pressSensitivityMixed: perf.pressSensitivityMixed,
    setPressSensitivityForSelection: perf.setPressSensitivityForSelection,
    releaseSensitivity: perf.releaseSensitivity,
    releaseSensitivityMixed: perf.releaseSensitivityMixed,
    setReleaseSensitivityForSelection: perf.setReleaseSensitivityForSelection,
    deadzoneEnabled: perf.deadzoneEnabled,
    deadzoneEnabledMixed: perf.deadzoneEnabledMixed,
    setDeadzoneEnabledForSelection: perf.setDeadzoneEnabledForSelection,
    deadzoneControlsEnabled: perf.deadzoneControlsEnabled,
    topDeadzone: perf.topDeadzone,
    topDeadzoneMixed: perf.topDeadzoneMixed,
    setTopDeadzoneForSelection: perf.setTopDeadzoneForSelection,
    bottomDeadzone: perf.bottomDeadzone,
    bottomDeadzoneMixed: perf.bottomDeadzoneMixed,
    setBottomDeadzoneForSelection: perf.setBottomDeadzoneForSelection
  };
}

export function DriverQuickPage(props: Props & { sw?: SwitchSetupState }) {
  const { driver, state, perf, sw } = props;
  const { option: selectedSwitch, mixed: switchMixed } = useSwitch(driver, perf, sw);
  if (!state.draft) return <Loading state={state} />;
  return (
    <div className={capClasses(driver)}>
      <ReadOnlyNotice driver={driver} />
      <QuickSettingsPage
        {...perfPageProps(perf)}
        actuationByKey={perf.actuationByKey}
        selectedSwitch={selectedSwitch}
        switchProfileMixed={switchMixed}
        actuation={perf.actuation}
        actuationMixed={perf.actuationMixed}
        setActuationForSelection={perf.setActuationForSelection}
        tachyonBusy={false}
        tachyon={false}
        handleTachyonChange={async () => undefined}
        deviceConnected
      />
      <ActuationSave {...props} />
    </div>
  );
}

export function DriverRapidPage(props: Props) {
  const { driver, state, perf, busy } = props;
  if (!state.draft) return <Loading state={state} />;
  const caps = driver.capabilities;
  return (
    <div className={capClasses(driver)}>
      <ReadOnlyNotice driver={driver} />
      <RapidPage
        {...perfPageProps(perf)}
        rapidTriggerByKey={perf.rapidTriggerByKey}
        continuous={
          caps.continuousRapidTrigger
            ? {
                checked: perf.continuous,
                mixed: perf.continuousMixed,
                onChange: perf.setContinuousForSelection,
                disabled: !perf.rapidTriggerControlsEnabled || busy
              }
            : undefined
        }
      />
      <ActuationSave {...props} />
    </div>
  );
}

function focusOf(hall: Hall, perf: OpenAulaPerformance) {
  const samples = hall.state.samples;
  const active = Object.values(samples)
    .filter(s => s.pressed || s.visualDistanceMm >= 0.05)
    .sort((a, b) => b.timestampMs - a.timestampMs);
  const inSelection = active.filter(s => perf.selectedKeys.has(s.keyId));
  const focusKeyId =
    inSelection[0]?.keyId ?? (perf.selectedKeys.size === 1 ? [...perf.selectedKeys][0] : null);
  const focus = focusKeyId ? samples[focusKeyId] : undefined;
  const travelMm = focus?.visualDistanceMm ?? 0;
  const thresholdMm = focusKeyId
    ? (perf.actuationByKey[focusKeyId] ?? perf.actuation)
    : perf.actuation;
  const pct = (mm: number) => Math.max(0, Math.min(100, (mm / HERO68_HALL_VISUAL_MAX_MM) * 100));
  return {
    active,
    focusKeyId,
    travelMm,
    travelPercent: pct(travelMm),
    thresholdMm,
    thresholdPercent: pct(thresholdMm),
    triggered: Boolean(focus && travelMm >= thresholdMm)
  };
}

function previewByKey(hall: Hall) {
  return Object.fromEntries(
    Object.entries(hall.state.samples).map(([id, s]) => [
      id,
      {
        distanceMm: s.visualDistanceMm,
        rawAdc: s.rawAdc,
        pressed: s.pressed,
        releaseInferred: s.releaseInferred
      }
    ])
  );
}

export function DriverActuationPage(props: Props & { hall: Hall; sw?: SwitchSetupState }) {
  const { driver, state, perf, hall, sw } = props;
  const { option: selectedSwitch, mixed: switchMixed } = useSwitch(driver, perf, sw);
  const [previewWidth, setPreviewWidth] = useState<number | undefined>();
  if (!state.draft) return <Loading state={state} />;
  const f = focusOf(hall, perf);
  return (
    <div className={capClasses(driver)}>
      <ReadOnlyNotice driver={driver} />
      <ActuationPage
        model={perf.model}
        actuationPreviewWidth={previewWidth}
        setActuationPreviewWidth={setPreviewWidth}
        advancedBindings={[]}
        selectedKeys={perf.selectedKeys}
        toggleKey={perf.toggleKey}
        onSelectKeys={perf.onSelectKeys}
        actuationByKey={perf.actuationByKey}
        hallStreamPreviewByKey={previewByKey(hall)}
        hasSelection={perf.hasSelection}
        allSelected={perf.allSelected}
        selectAll={perf.selectAll}
        discardSelection={perf.discardSelection}
        switchProfileMixed={switchMixed}
        selectedSwitch={selectedSwitch}
        actuation={perf.actuation}
        actuationMixed={perf.actuationMixed}
        setActuationForSelection={perf.setActuationForSelection}
        hallStream={hall.state}
        deviceConnected={driver.capabilities.travelStream}
        handleActuationHallStreamToggle={hall.toggle}
        actuationHallTriggered={f.triggered}
        actuationHallFocusKeyId={f.focusKeyId}
        actuationHallTravelMm={f.travelMm}
        actuationHallTravelPercent={f.travelPercent}
        actuationHallThresholdPercent={f.thresholdPercent}
        actuationHallThresholdMm={f.thresholdMm}
        releasePoint={
          driver.capabilities.releasePoint
            ? {
                value: perf.release,
                mixed: perf.releaseMixed,
                onChange: perf.setReleaseForSelection,
                min: Math.max(driver.capabilities.travelStepMm, 0.1),
                max: driver.capabilities.ranges?.actuation?.max ?? driver.capabilities.travelMm,
                step: Math.max(driver.capabilities.travelStepMm, 0.01),
                rapidTriggerOn: perf.rapidTrigger && !perf.rapidTriggerMixed
              }
            : undefined
        }
      />
      <ActuationSave {...props} />
    </div>
  );
}

export function DriverStreamPage({
  driver,
  perf,
  hall
}: {
  driver: KeyboardDriver;
  perf: OpenAulaPerformance;
  hall: Hall;
}) {
  const [pinned, setPinned] = useState<string | null>(null);
  const f = focusOf(hall, { ...perf, selectedKeys: new Set() } as OpenAulaPerformance);
  const focusKeyId = pinned ?? f.active[0]?.keyId ?? null;
  const focusSample = focusKeyId ? hall.state.samples[focusKeyId] : undefined;
  return (
    <div className={capClasses(driver)}>
      <StreamPage
        model={perf.model}
        hallStream={hall.state}
        deviceConnected={driver.capabilities.travelStream}
        handleHallStreamToggle={hall.toggle}
        advancedBindings={[]}
        hallStreamPreviewSelection={new Set(pinned ? [pinned] : [])}
        toggleHallStreamPin={id => setPinned(p => (p === id ? null : id))}
        hallStreamPreviewByKey={previewByKey(hall)}
        hallStreamPinnedKeyId={pinned}
        hallStreamFocusKeyId={focusKeyId}
        hallStreamFocusSample={focusSample}
        hallStreamFocusPercent={
          focusSample
            ? Math.max(
                0,
                Math.min(100, (focusSample.visualDistanceMm / HERO68_HALL_VISUAL_MAX_MM) * 100)
              )
            : 0
        }
        hallStreamActiveSamples={f.active}
        hallStreamListKeyIds={f.active.map(s => s.keyId)}
      />
    </div>
  );
}
