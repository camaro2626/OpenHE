/**
 * Guided calibration (Sparklink): start, press every key to the bottom while
 * the board's picture marks the keys it has learned, then finish and save.
 */

import { useEffect, useRef, useState } from 'react';
import Hero68Preview from '../components/Hero68Preview';
import type { HeroDeviceModelId } from '../keyboard/devices';
import type { KeyboardDriver } from '../drivers/types';
import { keyIdOf } from './boardModel';

type Phase = 'idle' | 'running' | 'finishing' | 'done';

const POLL_MS = 400;

export function GuidedCalibration({
  driver,
  model,
  busy
}: {
  driver: KeyboardDriver;
  model: HeroDeviceModelId;
  busy: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [done, setDone] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmEarly, setConfirmEarly] = useState(false);
  const live = useRef(true);
  const n = driver.layout.keys.length;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // poll progress while running; one read at a time
  useEffect(() => {
    if (phase !== 'running') return;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        try {
          const p = await driver.calibrationProgress!();
          if (!stop && live.current) setDone(p);
        } catch (err) {
          if (!stop && live.current) setError(err instanceof Error ? err.message : String(err));
        }
        await new Promise(r => setTimeout(r, POLL_MS));
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [phase, driver]);

  // leaving the page mid-calibration: finish rather than leave the board learning
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(
    () => () => {
      if (phaseRef.current === 'running') void driver.finishCalibration!().catch(() => undefined);
    },
    [driver]
  );

  const count = done.filter(Boolean).length;
  const all = n > 0 && count === n;

  const start = async () => {
    setError(null);
    setConfirmEarly(false);
    try {
      await driver.startCalibration!();
      setDone(new Array(n).fill(false));
      setPhase('running');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const finish = async () => {
    if (!all && !confirmEarly) {
      setConfirmEarly(true);
      return;
    }
    setPhase('finishing');
    try {
      await driver.finishCalibration!();
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('running');
    }
  };

  return (
    <div className="drv-guided-cal">
      {error && <div className="drv-notice is-error">{error}</div>}
      {phase === 'idle' || phase === 'done' ? (
        <>
          {phase === 'done' && (
            <div className="drv-notice">
              Calibration saved{all ? '' : ` (${count} of ${n} keys learned)`}.
            </div>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void start()}
          >
            {phase === 'done' ? 'Calibrate again' : 'Start calibration'}
          </button>
        </>
      ) : (
        <>
          <div className="drv-guided-cal-status">
            <b>
              {count} / {n} keys
            </b>
            <span className="drv-muted">
              {all
                ? 'Every key is learned. Finish to save.'
                : 'Press every key slowly all the way down and let it come back up. Keys turn green once the board has them.'}
            </span>
          </div>
          <section className="keyboard-stage drv-stage">
            <Hero68Preview
              model={model}
              selectedKeys={new Set()}
              onToggleKey={() => undefined}
              keyClassNames={Object.fromEntries(
                done.flatMap((ok, i) => (ok ? [[keyIdOf(i), 'drv-cal-done']] : []))
              )}
            />
          </section>
          <span className="drv-toolbar-actions">
            <button
              type="button"
              className={all ? 'apply-button' : 'secondary-button'}
              disabled={phase === 'finishing'}
              onClick={() => void finish()}
            >
              {phase === 'finishing'
                ? 'Saving…'
                : confirmEarly
                  ? `Finish with ${n - count} keys unlearned?`
                  : 'Finish and save'}
            </button>
          </span>
          {confirmEarly && (
            <small className="drv-muted">
              Keys not pressed during calibration may read travel wrongly until they are calibrated.
              Click again to finish anyway.
            </small>
          )}
        </>
      )}
    </div>
  );
}
