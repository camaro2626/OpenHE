/**
 * Crosstalk measurement: one key at a time, the key to press red (on the
 * picture and on the keyboard's own LEDs), keys done green. Each press must
 * be steady and alone; the result goes into the board's compensation table
 * once you save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hero68Preview from '../components/Hero68Preview';
import type { HeroDeviceModelId } from '../keyboard/devices';
import type { CrosstalkPair, KeyboardDriver } from '../drivers/types';
import { keyIdOf } from './boardModel';
import { HOLD_MIN, MAX_K, capture, mergeTable } from './crosstalk';

type Phase = 'idle' | 'baseline' | 'measuring' | 'review' | 'saving';

const POLL_MS = 25;
const HOLD_STEADY_MS = 400;
const CAPTURE_READS = 6;
const BASELINE_READS = 30;
const GUIDE_REFRESH_MS = 3000;

const pct = (k: number) => `${(k * 100).toFixed(1)} %`;

export function CrosstalkTool({
  driver,
  model,
  busy
}: {
  driver: KeyboardDriver;
  model: HeroDeviceModelId;
  busy: boolean;
}) {
  const keys = driver.layout.keys;
  const n = keys.length;
  const name = useCallback((i: number) => keys[i]?.label || `key ${i + 1}`, [keys]);
  const fwToLayout = useMemo(() => new Map(keys.map((k, i) => [k.index, i])), [keys]);

  const [stored, setStored] = useState<CrosstalkPair[] | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [target, setTarget] = useState<number | null>(null);
  const [done, setDone] = useState<boolean[]>(() => new Array(n).fill(false));
  const [measured, setMeasured] = useState<Map<number, CrosstalkPair[]>>(new Map());
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // the loop reads these without restarting
  const live = useRef({ target, done, phase });
  live.current = { target, done, phase };

  useEffect(() => {
    driver.getCrosstalk!()
      .then(setStored)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [driver]);

  const read = useCallback(async () => {
    const samples = await driver.readTravel!();
    const out = new Array<number>(n).fill(0);
    for (const s of samples) {
      const i = fwToLayout.get(s.index);
      if (i !== undefined) out[i] = s.raw ?? 0;
    }
    return out;
  }, [driver, n, fwToLayout]);

  const average = useCallback(
    async (count: number) => {
      const acc = new Array<number>(n).fill(0);
      for (let r = 0; r < count; r++) {
        const v = await read();
        v.forEach((x, i) => (acc[i] += x));
      }
      return acc.map(x => x / count);
    },
    [read, n]
  );

  // the keyboard's own LEDs follow the picture; refreshed so they stay on,
  // and turned off as soon as measuring stops
  const guiding = phase === 'measuring' || phase === 'baseline';
  useEffect(() => {
    if (!driver.setKeyGuide) return;
    if (!guiding) {
      void driver.setKeyGuide(null).catch(() => undefined);
      return;
    }
    const send = () =>
      void driver.setKeyGuide!({ red: phase === 'measuring' ? target : null, done }).catch(
        () => undefined
      );
    send();
    const t = setInterval(send, GUIDE_REFRESH_MS);
    return () => clearInterval(t);
  }, [driver, guiding, phase, target, done]);
  useEffect(() => () => void driver.setKeyGuide?.(null).catch(() => undefined), [driver]);

  const nextKey = (from: number, doneNow: boolean[]) => {
    for (let s = 1; s <= n; s++) {
      const i = (from + s) % n;
      if (!doneNow[i]) return i;
    }
    return null;
  };

  // the measuring loop: started when measuring starts, stopped when it ends
  const measuring = phase === 'baseline' || phase === 'measuring';
  useEffect(() => {
    if (!measuring) return;
    let stop = false;
    (async () => {
      try {
        let base = await average(BASELINE_READS);
        if (stop) return;
        setPhase('measuring');
        setNote(null);
        let heldSince: number | null = null;
        let waitRelease = false;
        while (!stop) {
          await new Promise(r => setTimeout(r, POLL_MS));
          const t = live.current.target;
          if (t === null) continue;
          const now = await read();
          const move = now.map((v, i) => Math.abs(v - base[i]));
          const most = Math.max(...move);
          if (waitRelease) {
            if (most < HOLD_MIN / 3) waitRelease = false;
            continue;
          }
          if (move[t] < HOLD_MIN) {
            heldSince = null;
            // idle: follow slow drift of the rest readings
            if (most < 15) base = base.map((b, i) => 0.98 * b + 0.02 * now[i]);
            continue;
          }
          heldSince ??= performance.now();
          if (performance.now() - heldSince < HOLD_STEADY_MS) continue;
          const held = await average(CAPTURE_READS);
          if (stop) return;
          heldSince = null;
          waitRelease = true;
          const res = capture(base, held, t);
          if (!res.ok) {
            setNote(
              res.reason === 'not-held'
                ? `${name(t)} was let go too soon: hold it down until it turns green.`
                : res.reason === 'other-key'
                  ? `${name(res.key!)} was pressed too. Press ${name(t)} alone.`
                  : `${name(res.key!)} moved too much (over ${pct(MAX_K)}): a finger was probably on it. Press ${name(t)} again without touching its neighbours.`
            );
            continue;
          }
          const strongest = [...res.pairs].sort((a, b) => b.k - a.k)[0];
          setNote(
            strongest
              ? `${name(t)}: ${res.pairs.length} neighbour${res.pairs.length > 1 ? 's' : ''} affected, most ${name(strongest.victim)} at ${pct(strongest.k)}.`
              : `${name(t)}: no neighbour affected.`
          );
          setMeasured(m => new Map(m).set(t, res.pairs));
          const doneNow = live.current.done.map((d, i) => d || i === t);
          setDone(doneNow);
          const next = nextKey(t, doneNow);
          setTarget(next);
          if (next === null) {
            setPhase('review');
            return;
          }
        }
      } catch (err) {
        if (!stop) {
          setError(err instanceof Error ? err.message : String(err));
          setPhase('idle');
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [measuring, average, read, name]);

  const start = () => {
    setError(null);
    setSaved(null);
    setNote('Hands off the keyboard for a moment…');
    const fresh = new Array(n).fill(false);
    setDone(fresh);
    setMeasured(new Map());
    setTarget(0);
    setPhase('baseline');
  };

  const pairs = [...measured.values()].flat();
  const table = stored
    ? mergeTable(stored, pairs, new Set(measured.keys()), driver.crosstalkSlots ?? 96)
    : [];
  const save = async (next: CrosstalkPair[], label: string) => {
    setPhase('saving');
    try {
      await driver.setCrosstalk!(next);
      setStored(next);
      setSaved(label);
      setPhase('idle');
      setNote(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('review');
    }
  };

  const count = done.filter(Boolean).length;
  const running = phase === 'baseline' || phase === 'measuring';
  const strongest = stored?.length ? Math.max(...stored.map(p => p.k)) : 0;

  return (
    <div className="drv-guided-cal drv-crosstalk">
      {error && <div className="drv-notice is-error">{error}</div>}
      {saved && <div className="drv-notice">{saved}</div>}
      {phase === 'idle' && (
        <>
          <span className="drv-muted">
            {stored === null
              ? 'Reading the stored table…'
              : stored.length
                ? `Stored: ${stored.length} pairs, strongest ${pct(strongest)}.`
                : 'No compensation stored.'}
          </span>
          <span className="drv-toolbar-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || stored === null}
              onClick={start}
            >
              Measure crosstalk
            </button>
            {!!stored?.length && (
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() => void save([], 'Crosstalk compensation is off.')}
              >
                Turn compensation off
              </button>
            )}
          </span>
        </>
      )}
      {(running || phase === 'review' || phase === 'saving') && (
        <>
          <div className="drv-guided-cal-status">
            <b>
              {count} / {n} keys
            </b>
            <span className="drv-muted">
              {phase === 'baseline'
                ? 'Hands off the keyboard…'
                : phase === 'measuring' && target !== null
                  ? `Press ${name(target)} all the way down with one finger and hold it until it turns green. Touch nothing else.`
                  : `Done: ${pairs.length} pairs measured. Saving keeps the stored pairs of keys you skipped.`}
            </span>
            {note && <span>{note}</span>}
          </div>
          <section className="keyboard-stage drv-stage">
            <Hero68Preview
              model={model}
              selectedKeys={new Set()}
              onToggleKey={() => undefined}
              keyClassNames={Object.fromEntries([
                ...done.flatMap((ok, i) => (ok ? [[keyIdOf(i), 'drv-cal-done']] : [])),
                ...(running && target !== null ? [[keyIdOf(target), 'drv-xt-target']] : [])
              ])}
            />
          </section>
          <span className="drv-toolbar-actions">
            {running && (
              <>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={target === null}
                  onClick={() => target !== null && setTarget(nextKey(target, done))}
                >
                  Skip this key
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPhase('review')}
                >
                  Finish
                </button>
              </>
            )}
            {(phase === 'review' || phase === 'saving') && (
              <>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={phase === 'saving'}
                  onClick={() => {
                    setPhase('idle');
                    setNote(null);
                  }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="apply-button"
                  disabled={phase === 'saving' || !measured.size}
                  onClick={() =>
                    void save(
                      table,
                      `Saved: ${table.length} pairs, applied now and from every start.`
                    )
                  }
                >
                  {phase === 'saving' ? 'Saving…' : 'Save to keyboard'}
                </button>
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}
