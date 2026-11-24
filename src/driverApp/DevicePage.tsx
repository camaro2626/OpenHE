import { useState } from 'react';
import type { KeyboardDriver } from '../drivers/types';
import { BoardView } from './BoardView';
import { driverConnection } from './store';

type LayoutCheck = KeyboardDriver & {
  needsLayoutConfirmation?: boolean;
  confirmLayout?: () => void;
  matchRate?: number;
};

export function DevicePage({
  driver,
  busy,
  run,
  onLayoutConfirmed
}: {
  driver: KeyboardDriver;
  busy: boolean;
  run: (label: string, task: () => Promise<void>) => Promise<boolean>;
  onLayoutConfirmed: () => void;
}) {
  const d = driver as LayoutCheck;
  const [confirmReset, setConfirmReset] = useState(false);
  const info = driver.info;
  const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;
  const sources: Record<string, string> = {
    board: 'reported by the keyboard',
    registry: 'from the board list',
    inferred: 'matched against the keyboard’s keymap',
    grid: 'no picture found; keys are shown by matrix slot'
  };

  return (
    <div className="drv-page">
      <section className="drv-panel">
        <h3>Keyboard</h3>
        <dl className="drv-info">
          <dt>Name</dt>
          <dd>{info.name}</dd>
          <dt>Driver</dt>
          <dd>
            {driver.id === 'openhe'
              ? 'openhe'
              : driver.id === 'sparklink'
                ? 'Sparklink (vendor protocol v2)'
                : 'RongYuan (sharkfin protocol)'}
          </dd>
          <dt>Firmware</dt>
          <dd>{info.firmwareVersion}</dd>
          <dt>USB</dt>
          <dd>
            {hex(info.vendorId)}:{hex(info.productId)}
          </dd>
          {info.serial && (
            <>
              <dt>Serial</dt>
              <dd>{info.serial}</dd>
            </>
          )}
          <dt>Layout</dt>
          <dd>
            {driver.layout.keys.length} keys, {sources[driver.layout.source ?? 'board']}
          </dd>
          <dt>Profiles / layers</dt>
          <dd>
            {driver.capabilities.profiles} / {driver.capabilities.layers}
          </dd>
        </dl>
      </section>

      {d.needsLayoutConfirmation && d.confirmLayout && (
        <section className="drv-panel">
          <h3>Is this your keyboard?</h3>
          <p className="drv-muted">
            The picture below was matched against the keymap read from the board (
            {Math.round((d.matchRate ?? 0) * 100)}% of keys matched). Writes stay off until you
            confirm it, so a wrong match cannot remap the wrong keys.
          </p>
          <BoardView layout={driver.layout} render={i => <b>{driver.layout.keys[i]?.label}</b>} />
          <div className="drv-actions">
            <button
              type="button"
              className="ghost-button apply-button"
              onClick={() => {
                d.confirmLayout?.();
                onLayoutConfirmed();
              }}
            >
              Yes, this is my keyboard
            </button>
          </div>
        </section>
      )}

      {(driver.reboot || driver.enterBootloader || driver.factoryReset) && (
        <section className="drv-panel">
          <h3>Maintenance</h3>
          {(driver.reboot || driver.enterBootloader) && (
            <div className="drv-field drv-field-row">
              <span>
                Restart
                <small className="drv-muted">
                  {' '}
                  Restart the keyboard, or start its bootloader to flash new firmware. The keyboard
                  disconnects either way.
                </small>
              </span>
              <span className="drv-toolbar-actions">
                {driver.reboot && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={async () => {
                      await run('Restarting', () => driver.reboot!());
                      await driverConnection.disconnect();
                    }}
                  >
                    Restart
                  </button>
                )}
                {driver.enterBootloader && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={async () => {
                      await run('Starting the bootloader', () => driver.enterBootloader!());
                      await driverConnection.disconnect();
                    }}
                  >
                    Bootloader
                  </button>
                )}
              </span>
            </div>
          )}
          {driver.factoryReset && (
            <div className="drv-field drv-field-row">
              <span>
                Factory reset
                <small className="drv-muted">
                  {' '}
                  Erases every profile, keymap and setting on the keyboard.
                </small>
              </span>
              {confirmReset ? (
                <span className="drv-toolbar-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setConfirmReset(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="secondary-button is-danger"
                    disabled={busy}
                    onClick={async () => {
                      setConfirmReset(false);
                      await run('Resetting', () => driver.factoryReset!());
                    }}
                  >
                    Erase everything
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  Factory reset…
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
