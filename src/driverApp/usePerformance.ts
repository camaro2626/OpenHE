/**
 * Bridges OpenHE's per-key actuation draft (driver indexes, KeyActuation) to
 * the props OpenAula's Quick Settings, Actuation Point and Rapid Trigger pages
 * take (key ids, per-key maps, selection-wide values and setters), the way
 * OpenAula's own usePerKeyPerformance does for AULA boards.
 */

import { useCallback, useMemo, useState } from 'react';
import { formatMillimeters, selectionHasMixedValues, snapToStep } from '../app/helpers';
import type { KeyActuation } from '../drivers/types';
import { heroLayout } from '../keyboard/layout';
import type { HeroDeviceModelId } from '../keyboard/devices';
import { indexOfKeyId, keyIdOf } from './boardModel';
import type { ActuationDraft } from './actuationDraft';

export type PreviewMode = 'none' | 'actuation' | 'rapid' | 'deadzone';

const pick = (selected: Set<string>, byKey: Record<string, number>, fallback: number) => {
  const first = selected.values().next().value;
  return first !== undefined ? (byKey[first] ?? fallback) : fallback;
};

export function useOpenAulaPerformance(
  model: HeroDeviceModelId,
  state: ActuationDraft,
  /** The board's smallest step: labels show it when finer than 0.005 mm. */
  stepMm = 0.005
) {
  const { draft, setDraft } = state;
  const keyIds = useMemo(() => heroLayout(model).keyIds, [model]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [quickPreviewMode, setQuickPreviewMode] = useState<PreviewMode>('none');

  const map = useMemo(
    () =>
      function perKey<T>(fn: (a: KeyActuation) => T): Record<string, T> {
        return Object.fromEntries(
          keyIds.flatMap(id => {
            const a = draft?.[indexOfKeyId(id)];
            return a ? [[id, fn(a)]] : [];
          })
        );
      },
    [draft, keyIds]
  );

  const actuationByKey = useMemo(() => map(a => a.actuationMm), [map]);
  const rapidTriggerByKey = useMemo(() => map(a => a.rapidTrigger), [map]);
  const splitByKey = useMemo(() => map(a => a.splitSensitivity), [map]);
  const pressByKey = useMemo(() => map(a => a.rtPressMm), [map]);
  const releaseByKey = useMemo(() => map(a => a.rtReleaseMm), [map]);
  const deadzoneByKey = useMemo(() => map(a => a.deadzoneEnabled), [map]);
  const topByKey = useMemo(() => map(a => a.topDeadzoneMm), [map]);
  const bottomByKey = useMemo(() => map(a => a.bottomDeadzoneMm), [map]);

  const rapidPreviewByKey = useMemo(
    () =>
      map(a => ({
        primary: formatMillimeters(a.rtPressMm, 2, stepMm),
        secondary: a.splitSensitivity ? formatMillimeters(a.rtReleaseMm, 2, stepMm) : undefined,
        active: a.rapidTrigger
      })),
    [map, stepMm]
  );
  const deadzonePreviewByKey = useMemo(
    () =>
      map(a => ({
        top: formatMillimeters(snapToStep(a.topDeadzoneMm, 0, 1, 0.01)),
        bottom: formatMillimeters(snapToStep(a.bottomDeadzoneMm, 0, 1, 0.01)),
        active: a.deadzoneEnabled
      })),
    [map]
  );

  const hasSelection = selectedKeys.size > 0;
  const update = useCallback(
    (fn: (a: KeyActuation) => KeyActuation) =>
      setDraft(d => {
        if (!d) return d;
        const next = d.slice();
        for (const id of selectedKeys) {
          const i = indexOfKeyId(id);
          if (next[i]) next[i] = fn(next[i]);
        }
        return next;
      }),
    [selectedKeys, setDraft]
  );

  const actuation = pick(selectedKeys, actuationByKey, 2);
  const rapidTrigger = Boolean(
    pick(
      selectedKeys,
      map(a => (a.rapidTrigger ? 1 : 0)),
      0
    )
  );
  const splitSensitivity = Boolean(
    pick(
      selectedKeys,
      map(a => (a.splitSensitivity ? 1 : 0)),
      0
    )
  );
  const deadzoneEnabled = Boolean(
    pick(
      selectedKeys,
      map(a => (a.deadzoneEnabled ? 1 : 0)),
      0
    )
  );
  const rapidTriggerMixed = selectionHasMixedValues(selectedKeys, rapidTriggerByKey);
  const splitSensitivityMixed = selectionHasMixedValues(selectedKeys, splitByKey);
  const deadzoneEnabledMixed = selectionHasMixedValues(selectedKeys, deadzoneByKey);
  const rapidTriggerControlsEnabled = hasSelection && rapidTrigger && !rapidTriggerMixed;

  return {
    model,
    keyIds,
    selectedKeys,
    setSelectedKeys,
    quickPreviewMode,
    setQuickPreviewMode,
    actuationByKey,
    rapidTriggerByKey,
    rapidPreviewByKey,
    deadzonePreviewByKey,
    hasSelection,
    allSelected: hasSelection && selectedKeys.size === keyIds.length,
    selectAll: () => setSelectedKeys(new Set(keyIds)),
    discardSelection: () => setSelectedKeys(new Set()),
    toggleKey: (keyId: string) =>
      setSelectedKeys(prev => {
        const next = new Set(prev);
        if (next.has(keyId)) next.delete(keyId);
        else next.add(keyId);
        return next;
      }),
    onSelectKeys: (next: Set<string>) => setSelectedKeys(new Set(next)),

    actuation,
    actuationMixed: selectionHasMixedValues(selectedKeys, actuationByKey),
    setActuationForSelection: (v: number) => update(a => ({ ...a, actuationMm: v })),

    rapidTrigger,
    rapidTriggerMixed,
    setRapidTriggerForSelection: (v: boolean) => update(a => ({ ...a, rapidTrigger: v })),
    rapidTriggerControlsEnabled,
    splitSensitivity,
    splitSensitivityMixed,
    setSplitSensitivityForSelection: (v: boolean) =>
      // turning the split on starts both sides from the shared sensitivity
      update(a => ({ ...a, splitSensitivity: v, rtReleaseMm: v ? a.rtPressMm : a.rtReleaseMm })),
    splitSensitivityControlsEnabled: rapidTriggerControlsEnabled && !splitSensitivityMixed,
    rapidSensitivity: pick(selectedKeys, pressByKey, 0.3),
    rapidSensitivityMixed: selectionHasMixedValues(selectedKeys, pressByKey),
    setRapidSensitivityForSelection: (v: number) => update(a => ({ ...a, rtPressMm: v })),
    pressSensitivity: pick(selectedKeys, pressByKey, 0.3),
    pressSensitivityMixed: selectionHasMixedValues(selectedKeys, pressByKey),
    setPressSensitivityForSelection: (v: number) => update(a => ({ ...a, rtPressMm: v })),
    releaseSensitivity: pick(selectedKeys, releaseByKey, 0.3),
    releaseSensitivityMixed: selectionHasMixedValues(selectedKeys, releaseByKey),
    setReleaseSensitivityForSelection: (v: number) => update(a => ({ ...a, rtReleaseMm: v })),

    deadzoneEnabled,
    deadzoneEnabledMixed,
    setDeadzoneEnabledForSelection: (v: boolean) => update(a => ({ ...a, deadzoneEnabled: v })),
    deadzoneControlsEnabled: hasSelection && deadzoneEnabled && !deadzoneEnabledMixed,
    topDeadzone: pick(selectedKeys, topByKey, 0),
    topDeadzoneMixed: selectionHasMixedValues(selectedKeys, topByKey),
    setTopDeadzoneForSelection: (v: number) => update(a => ({ ...a, topDeadzoneMm: v })),
    bottomDeadzone: pick(selectedKeys, bottomByKey, 0),
    bottomDeadzoneMixed: selectionHasMixedValues(selectedKeys, bottomByKey),
    setBottomDeadzoneForSelection: (v: number) => update(a => ({ ...a, bottomDeadzoneMm: v })),

    /** Continuous RT (OpenHE firmware only; not part of OpenAula's pages). */
    continuous: Boolean(
      pick(
        selectedKeys,
        map(a => (a.continuous ? 1 : 0)),
        0
      )
    ),
    continuousMixed: selectionHasMixedValues(
      selectedKeys,
      map(a => a.continuous)
    ),
    setContinuousForSelection: (v: boolean) => update(a => ({ ...a, continuous: v })),

    /** Release point with Rapid Trigger off (RongYuan; not part of OpenAula's pages). */
    release: pick(
      selectedKeys,
      map(a => a.releaseMm ?? a.actuationMm),
      actuation
    ),
    releaseMixed: selectionHasMixedValues(
      selectedKeys,
      map(a => a.releaseMm ?? a.actuationMm)
    ),
    setReleaseForSelection: (v: number) => update(a => ({ ...a, releaseMm: v })),
    keyIdOf
  };
}

export type OpenAulaPerformance = ReturnType<typeof useOpenAulaPerformance>;
