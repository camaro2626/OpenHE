import {
  ArrowRight,
  Cable,
  Gauge,
  Keyboard,
  Layers,
  Lightbulb,
  ListOrdered,
  Loader2,
  PlayCircle,
  Activity
} from 'lucide-react';
import logo from '../assets/openhe-logo.png';
import { appMode } from '../appMode';
import { BRAND } from '../brand';
import { driverConnection, useDriverConnection } from './store';

const FAMILIES = [
  {
    name: 'OpenHE firmware',
    detail:
      'Keyboards running OpenHE’s own firmware (built on libhmk), starting with the Skyloong GK68 TMR. Actuation in 0.01 mm steps, dead zones, gamepad mode; the board describes its own layout.'
  },
  {
    name: 'Sparklink magnetic boards',
    detail:
      'About 550 boards on Sparklink’s firmware (protocol v2), from its own published protocol: IROK, EWEADN, CAROTMAS, Everglide, Weikav, AULA AG75 and more. Keymap, actuation, rapid trigger, advanced keys, macros, lighting and live travel.'
  },
  {
    name: 'RongYuan magnetic boards',
    detail:
      'About 770 Hall-effect boards on RongYuan firmware (ry5088 and yc3121 lines), from the board list sharkfin keeps. Many sold by Akko, MonsGeek, AttackShark, Epomaker and others.'
  }
] as const;

const FEATURES = [
  {
    icon: Gauge,
    title: 'Actuation & rapid trigger',
    text: 'Per-key actuation, press and release sensitivity, dead zones.'
  },
  { icon: Keyboard, title: 'Key remap', text: 'Every layer, from a picture of your own board.' },
  { icon: Layers, title: 'Advanced keys', text: 'SOCD, dynamic keystroke, tap-hold and toggle.' },
  {
    icon: ListOrdered,
    title: 'Macros',
    text: 'Record a sequence and put it on any key: once, repeated, held or toggled.'
  },
  {
    icon: Lightbulb,
    title: 'Lighting',
    text: 'Your board’s own effects, colours, edge light and per-key colours.'
  },
  {
    icon: Activity,
    title: 'Live travel',
    text: 'Watch each switch move, in millimetres or raw counts.'
  }
] as const;

/** Start screen: connect an OpenHE-firmware or RongYuan board, or go to the AULA app. */
export function Landing() {
  const conn = useDriverConnection();
  const supported = driverConnection.supported();
  const connecting = conn.state === 'connecting';
  const error = conn.state === 'idle' ? conn.error : null;

  return (
    <div className="landing">
      <main className="landing-main">
        <header className="landing-brand">
          <img src={logo} alt="" />
          <span>{BRAND.displayName}</span>
        </header>

        <section className="landing-hero">
          <h1>Open configurator for magnetic keyboards</h1>
          <p>
            Set up Hall-effect and TMR keyboards in the browser. Nothing to install, no account, and
            nothing leaves your computer except the settings you send to the keyboard.
          </p>
          <div className="landing-cta">
            <button
              type="button"
              className="landing-connect"
              disabled={!supported || connecting}
              onClick={() => void driverConnection.request()}
            >
              {connecting ? <Loader2 size={18} className="rotate" /> : <Cable size={18} />}
              {connecting ? 'Connecting…' : 'Connect keyboard'}
            </button>
            <span className="landing-hint">
              Plug the keyboard in by cable, then pick it in the browser's list.
            </span>
          </div>
          <div className="landing-demo">
            <span>No keyboard to hand? Try a demo board:</span>
            <button
              type="button"
              className="secondary-button"
              disabled={connecting}
              onClick={() => void driverConnection.demo('sparklink')}
            >
              <PlayCircle size={15} /> Sparklink demo
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={connecting}
              onClick={() => void driverConnection.demo('rongyuan')}
            >
              <PlayCircle size={15} /> RongYuan demo
            </button>
          </div>
          {!supported && (
            <div className="landing-note is-error">
              This browser cannot talk to keyboards. Use Chrome, Edge or another Chromium browser on
              a desktop.
            </div>
          )}
          {error && <div className="landing-note is-error">{error}</div>}
        </section>

        <section className="landing-features">
          {FEATURES.map(f => (
            <div key={f.title} className="landing-feature">
              <f.icon size={20} />
              <b>{f.title}</b>
              <span>{f.text}</span>
            </div>
          ))}
        </section>

        <section className="landing-supported">
          <h2>Works with</h2>
          <div className="landing-families">
            {FAMILIES.map(f => (
              <div key={f.name} className="landing-family">
                <b>{f.name}</b>
                <span>{f.detail}</span>
              </div>
            ))}
            <button
              type="button"
              className="landing-family landing-aula"
              onClick={() => appMode.set('aula')}
            >
              <b>
                AULA keyboards <ArrowRight size={15} />
              </b>
              <span>
                HERO 68, HERO 84, HERO 68 XS and WIN 68 HE MAX use the OpenAula app, with lighting,
                macros and gamepad.
              </span>
            </button>
          </div>
        </section>

        <footer className="landing-footer">
          Built on <a href="https://github.com/shizunavn/OpenAula">OpenAula</a>, with the RongYuan
          protocol and board list from <a href="https://github.com/dniminenn/sharkfin">sharkfin</a>{' '}
          and OpenHE’s firmware built on <a href="https://github.com/peppapighs/libhmk">libhmk</a>.
          GPL-3.0.
        </footer>
      </main>
    </div>
  );
}
