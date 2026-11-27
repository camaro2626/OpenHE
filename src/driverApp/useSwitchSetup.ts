/**
 * The board's per-key switches as OpenAula switch options, shared by the
 * Switch Selector and the actuation pages (so the travel picture shows the
 * selected key's switch).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SWITCH_IMAGES,
  setRuntimeSwitchOptions,
  type SwitchOption,
  type SwitchTone
} from '../app/switchAssets';
import type { KeyboardDriver, SwitchCatalogEntry, SwitchSetup } from '../drivers/types';
// the UFO's manufacturer renders, shine toned down (see README, Credits)
import ufoFront from '../assets/switches/gravastar-ufo-front.webp';
import ufoTop from '../assets/switches/gravastar-ufo-top.webp';
import crystalBlueFront from '../assets/switches/crystal-blue-front.webp';
import crystalBlueTop from '../assets/switches/crystal-blue-top.webp';
// Wootility's renders (see README, Credits): a still, a top view and a
// 41-frame press for each
import gateronJadeFront from '../assets/switches/wooting/gateron-jade-front.webp';
import gateronJadeTop from '../assets/switches/wooting/gateron-jade-top.webp';
import gateronJadeSide from '../assets/switches/wooting/gateron-jade-side.webp';
import gateronJadeProFront from '../assets/switches/wooting/gateron-jade-pro-front.webp';
import gateronJadeProTop from '../assets/switches/wooting/gateron-jade-pro-top.webp';
import gateronJadeProSide from '../assets/switches/wooting/gateron-jade-pro-side.webp';
import gateronJadeGamingFront from '../assets/switches/wooting/gateron-jade-gaming-front.webp';
import gateronJadeGamingTop from '../assets/switches/wooting/gateron-jade-gaming-top.webp';
import gateronJadeGamingSide from '../assets/switches/wooting/gateron-jade-gaming-side.webp';
import gateronJadeEmeraldFront from '../assets/switches/wooting/gateron-jade-emerald-front.webp';
import gateronJadeEmeraldTop from '../assets/switches/wooting/gateron-jade-emerald-top.webp';
import gateronJadeEmeraldSide from '../assets/switches/wooting/gateron-jade-emerald-side.webp';
import ttcKomFront from '../assets/switches/wooting/ttc-kom-front.webp';
import ttcKomTop from '../assets/switches/wooting/ttc-kom-top.webp';
import ttcKomSide from '../assets/switches/wooting/ttc-kom-side.webp';
import ttcKomPomFront from '../assets/switches/wooting/ttc-kom-pom-front.webp';
import ttcKomPomTop from '../assets/switches/wooting/ttc-kom-pom-top.webp';
import ttcKomPomSide from '../assets/switches/wooting/ttc-kom-pom-side.webp';
import ttcKomRgbFront from '../assets/switches/wooting/ttc-kom-rgb-front.webp';
import ttcKomRgbTop from '../assets/switches/wooting/ttc-kom-rgb-top.webp';
import ttcKomRgbSide from '../assets/switches/wooting/ttc-kom-rgb-side.webp';
import owlabTiFront from '../assets/switches/wooting/owlab-ti-front.webp';
import owlabTiTop from '../assets/switches/wooting/owlab-ti-top.webp';
import owlabTiSide from '../assets/switches/wooting/owlab-ti-side.webp';
import type { HeroDeviceModelId } from '../keyboard/devices';

type Pictures = {
  front?: string;
  top?: string;
  simProfile?: string;
  sideFrames?: { src: string; count: number };
};
const openAula = (tone: string): Pictures => ({
  ...(SWITCH_IMAGES[tone as SwitchTone] ?? {}),
  simProfile: tone
});
/** Recolours of OpenAula's clear switch (scripts/switch-recolor.py) keep its animation. */
const recolour = (front: string, top: string): Pictures => ({ front, top, simProfile: 'clear' });

/** A switch with a pre-rendered press (41 frames, rest to bottom-out). */
const rendered = (front: string, top: string, side: string): Pictures => ({
  front,
  top,
  sideFrames: { src: side, count: 41 }
});
const W = {
  gateronJade: rendered(gateronJadeFront, gateronJadeTop, gateronJadeSide),
  gateronJadePro: rendered(gateronJadeProFront, gateronJadeProTop, gateronJadeProSide),
  gateronJadeGaming: rendered(gateronJadeGamingFront, gateronJadeGamingTop, gateronJadeGamingSide),
  gateronJadeEmerald: rendered(
    gateronJadeEmeraldFront,
    gateronJadeEmeraldTop,
    gateronJadeEmeraldSide
  ),
  ttcKom: rendered(ttcKomFront, ttcKomTop, ttcKomSide),
  ttcKomPom: rendered(ttcKomPomFront, ttcKomPomTop, ttcKomPomSide),
  ttcKomRgb: rendered(ttcKomRgbFront, ttcKomRgbTop, ttcKomRgbSide),
  owlabTi: rendered(owlabTiFront, owlabTiTop, owlabTiSide)
};

/** The Gravastar UFO's own shape, with its own press animation (switchSim). */
const GRAVASTAR_UFO: Pictures = { front: ufoFront, top: ufoTop, simProfile: 'gravastar-ufo' };

/** Pictures for OpenHE's own switches. */
const OWN_IMAGES: Record<string, Pictures> = {
  'gravastar-ufo': GRAVASTAR_UFO,
  'skyloong-crystal-blue': recolour(crystalBlueFront, crystalBlueTop),
  generic: openAula('black'),
  unset: openAula('white')
};
/**
 * Switches known by name: RongYuan's vendor lists and Sparklink's catalog
 * (English names from it). Exact names first; the first match wins.
 */
const BY_NAME: Array<[RegExp, Pictures]> = [
  // Gateron's Jade family
  [/^\s*magnetic jade\s*$/i, W.gateronJade],
  [/^\s*magnetic jade pro\s*$/i, W.gateronJadePro],
  [/^\s*magnetic jade gaming\s*$/i, W.gateronJadeGaming],
  [/^\s*emerald jade\s*$/i, W.gateronJadeEmerald],
  // TTC KOM (万磁王): sold as "Magneto" on RongYuan boards; the PRO is the
  // white-stem, white-base one and keeps its recolour
  [/^\s*magneto\s*pro\s*$/i, openAula('white')],
  [/^\s*(magneto|magneto king|ttc magnet king)\s*$/i, W.ttcKom],
  [/^\s*(pom magneto king|(all )?pom magnet king( axis)?)\s*$/i, W.ttcKomPom],
  [/^\s*(magneto king rgb|magneto rgb)\s*$/i, W.ttcKomRgb],
  [/^\s*owlab ti\s*$/i, W.owlabTi],
  // Fuling's vendor list names it "UFO Purple"
  [/\bufo\b/i, GRAVASTAR_UFO],
  // other Jade Pro / Gaming variants: OpenAula's Jade Pro
  [/jade\s*(pro|gaming)/i, openAula('jade-pro')]
];
const ACCENT: Record<string, string> = {
  generic: '#5b6268',
  'gravastar-ufo': '#8b5cf6',
  'skyloong-crystal-blue': '#5fd3bd',
  unset: '#9ba3a8'
};

function imagesFor(c: SwitchCatalogEntry): Pictures {
  return (
    OWN_IMAGES[c.id] ??
    BY_NAME.find(([re]) => re.test(c.name))?.[1] ??
    // anything else: the plain clear switch
    openAula('clear')
  );
}

const accentFor = (c: SwitchCatalogEntry) =>
  ACCENT[c.id] ??
  c.color ??
  (/jade/i.test(c.name) ? '#3fbf8f' : /^\s*magneto\s*$/i.test(c.name) ? '#e0222c' : '#9ba3a8');

export const switchOptionId = (catalogId: string) => `drv:${catalogId}` as SwitchTone;
export const catalogIdOf = (optionId: string) => optionId.replace(/^drv:/, '');

export function useSwitchSetup(driver: KeyboardDriver, model: HeroDeviceModelId) {
  const catalog = useMemo(() => driver.switchCatalog?.() ?? [], [driver]);
  const [saved, setSaved] = useState<SwitchSetup | null>(null);
  const [draft, setDraft] = useState<SwitchSetup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: SwitchOption[] = useMemo(
    () =>
      catalog.map(c => {
        const tuning = draft?.tuning[c.id];
        const travel = tuning?.travelMm ?? c.travelMm;
        return {
          id: switchOptionId(c.id),
          name: c.name,
          fullName: c.name,
          brand: c.brand,
          accent: accentFor(c),
          note: c.tunable
            ? `${travel.toFixed(2)} mm travel`
            : c.id === 'unset'
              ? 'Left as it is'
              : (c.detail ?? ''),
          travelMm: travel,
          ...imagesFor(c)
        };
      }),
    [catalog, draft]
  );

  // OpenAula's Switch Selector lists switchOptionsForModel(model)
  useEffect(() => {
    setRuntimeSwitchOptions(model, options);
  }, [model, options]);
  useEffect(() => () => setRuntimeSwitchOptions(null), []);

  const reload = useCallback(() => {
    if (!driver.getSwitchSetup || !catalog.length) return;
    setError(null);
    driver
      .getSwitchSetup()
      .then(s => {
        setSaved(s);
        setDraft(structuredClone(s));
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [driver, catalog.length]);
  useEffect(reload, [reload]);

  const optionOfKey = useCallback(
    (index: number): SwitchOption | undefined => {
      const id = draft?.keySwitch[index];
      return id ? options.find(o => o.id === switchOptionId(id)) : undefined;
    },
    [draft, options]
  );

  return {
    available: catalog.length > 0 && !!driver.setSwitchSetup,
    catalog,
    options,
    saved,
    draft,
    setDraft,
    setSaved,
    error,
    reload,
    optionOfKey,
    dirty: !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved)
  };
}

export type SwitchSetupState = ReturnType<typeof useSwitchSetup>;
