import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Crosshair,
  Gamepad2,
  Info,
  Keyboard,
  Layers3,
  ListOrdered,
  Lightbulb,
  Loader2,
  Settings,
  SlidersHorizontal,
  Zap
} from 'lucide-react';
import { version as uiVersion } from '../../package.json';
import logo from '../assets/openhe-logo.png';
import { BRAND } from '../brand';
import { AdvancedKeysMenuIcon } from '../app/components/AdvancedKeysMenuIcon';
import { KeyboardMenuIcon } from '../app/components/KeyboardMenuIcon';
import { KeyRemapMenuIcon } from '../app/components/KeyRemapMenuIcon';
import { RailItem } from '../app/components/RailItem';
import { RapidTriggerMenuIcon } from '../app/components/RapidTriggerMenuIcon';
import { SidebarItem } from '../app/components/SidebarItem';
import { SwitchStemMenuIcon } from '../app/components/SwitchStemMenuIcon';
import { SwitchesPage } from './SwitchesPage';
import { useSwitchSetup } from './useSwitchSetup';
import type { KeyboardDriver } from '../drivers/types';
import { AdvancedKeysPage } from './AdvancedKeysPage';
import MacroPage from '../components/MacroPage';
import { LightingPage } from './LightingPage';
import { BoardThumb } from './BoardThumb';
import { DevicePage } from './DevicePage';
import { GamepadPage } from './GamepadPage';
import { HelpPage } from './HelpPage';
import { useActuationDraft } from './actuationDraft';
import {
  DriverActuationPage,
  DriverQuickPage,
  DriverRapidPage,
  DriverStreamPage
} from './PerformancePages';
import { registerDriverBoard } from './boardModel';
import { setDisplayStepMm, setExtraKeyLabels } from '../app/helpers';
import { useOpenAulaPerformance } from './usePerformance';
import { useDriverHall } from './useDriverHall';
import { keyIdOf } from './boardModel';
import { RemapPage } from './RemapPage';
import { SaveSlotContext } from './SaveBar';
import {
  CalibrationSettingsPage,
  GeneralSettingsPage,
  ProfilesSettingsPage
} from './SettingsPages';
import { driverConnection } from './store';

type Rail = 'keyboard' | 'settings' | 'help';
type KeyboardPage =
  | 'quick'
  | 'actuation'
  | 'rapid'
  | 'stream'
  | 'remap'
  | 'advanced'
  | 'macros'
  | 'lighting'
  | 'gamepad';
type SettingsPage = 'general' | 'switches' | 'profiles' | 'calibration' | 'device';

const FAMILY_NAME: Partial<Record<KeyboardDriver['id'], string>> = {
  openhe: 'OpenHE',
  rongyuan: 'RongYuan',
  sparklink: 'Sparklink'
};

type NavItem<T> = { id: T; label: string; icon: ReactNode; show: boolean };

/** Workspace for boards behind the driver layer (OpenHE firmware, RongYuan), laid out like OpenAula. */
export function DriverApp({ driver }: { driver: KeyboardDriver }) {
  const caps = driver.capabilities;
  const confirmable = driver as KeyboardDriver & { needsLayoutConfirmation?: boolean };
  const [rail, setRail] = useState<Rail>(
    confirmable.needsLayoutConfirmation ? 'settings' : 'keyboard'
  );
  const [page, setPage] = useState<KeyboardPage>(caps.actuation ? 'quick' : 'remap');
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(
    confirmable.needsLayoutConfirmation ? 'device' : 'general'
  );
  const [compact, setCompact] = useState(false);
  const [profile, setProfile] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saveSlot, setSaveSlot] = useState<HTMLElement | null>(null);
  const [, setLayoutConfirmed] = useState(0);
  const actuation = useActuationDraft(driver, profile);
  // The board as an OpenAula model, so OpenAula's pages and preview draw it.
  const model = useMemo(() => {
    const id = registerDriverBoard(driver);
    setExtraKeyLabels(new Map(driver.layout.keys.map(k => [keyIdOf(k.index), k.label])));
    setDisplayStepMm(driver.capabilities.travelStepMm);
    return id;
  }, [driver]);
  const perf = useOpenAulaPerformance(model, actuation, caps.travelStepMm);
  const sw = useSwitchSetup(driver, model);
  const hall = useDriverHall(driver, i => actuation.draft?.[i]?.actuationMm);

  // Browser tab: the connected keyboard's name
  useEffect(() => {
    const previous = document.title;
    document.title = `${driver.info.name} · ${BRAND.displayName}`;
    return () => {
      document.title = previous;
    };
  }, [driver]);

  useEffect(() => {
    driver
      .getProfile()
      .then(setProfile)
      .catch(() => setProfile(0));
  }, [driver]);

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setStatus(null);
    try {
      await task();
      setStatus({
        kind: 'ok',
        text: label.startsWith('Writing ')
          ? label.replace(/^Writing /, 'Saved ')
          : `${label} — done`
      });
      return true;
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (status?.kind !== 'ok') return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  const selectProfile = async (next: number) => {
    if (next === profile || busy) return;
    if (caps.actuationActiveProfileOnly) {
      const setter = (driver as KeyboardDriver & { setProfile?: (p: number) => Promise<void> })
        .setProfile;
      if (
        setter &&
        !(await run(`Switching to profile ${next + 1}`, () => setter.call(driver, next)))
      )
        return;
    }
    setProfile(next);
  };

  const profileItems: NavItem<KeyboardPage>[] = [
    { id: 'quick', label: 'Quick Settings', icon: <Zap size={18} />, show: caps.actuation }
  ];
  const keyboardItems: NavItem<KeyboardPage>[] = [
    ...profileItems,
    {
      id: 'actuation',
      label: 'Actuation Point',
      icon: <ArrowDownToLine size={18} />,
      show: caps.actuation
    },
    {
      id: 'rapid',
      label: 'Rapid Trigger',
      icon: <RapidTriggerMenuIcon />,
      show: caps.rapidTrigger
    },
    { id: 'stream', label: 'Hall Stream', icon: <Activity size={18} />, show: caps.travelStream },
    { id: 'remap', label: 'Key Remap', icon: <KeyRemapMenuIcon />, show: true },
    {
      id: 'advanced',
      label: 'Advanced Keys',
      icon: <AdvancedKeysMenuIcon />,
      show: caps.advancedKeys.length > 0 && !!driver.getAdvancedKeys
    },
    {
      id: 'macros',
      label: 'Macros',
      icon: <ListOrdered size={18} />,
      show: caps.macros && caps.advancedKeys.includes('macro') && !!driver.setAdvancedKeys
    },
    {
      id: 'lighting',
      label: 'Lighting',
      icon: <Lightbulb size={18} />,
      show: caps.rgb && !!driver.lightingInfo && !!driver.getLighting
    },
    {
      id: 'gamepad',
      label: 'Gamepad',
      icon: <Gamepad2 size={18} />,
      show: caps.gamepad && !!driver.getGamepad
    }
  ];
  const settingsItems: NavItem<SettingsPage>[] = [
    {
      id: 'general',
      label: 'General Settings',
      icon: <KeyboardMenuIcon />,
      show: !!(driver.setOptions || driver.setTickRate)
    },
    {
      id: 'switches',
      label: 'Switch Selector',
      icon: <SwitchStemMenuIcon />,
      show: sw.available
    },
    {
      id: 'profiles',
      label: 'Profiles',
      icon: <Layers3 size={18} />,
      show: caps.profiles > 1 && !!(driver.resetProfile || driver.duplicateProfile)
    },
    {
      id: 'calibration',
      label: 'Calibration',
      icon: <Crosshair size={18} />,
      show: !!(driver.recalibrate || driver.setCalibration || driver.startCalibration)
    },
    { id: 'device', label: 'About this Keyboard', icon: <Info size={18} />, show: true }
  ];
  const activeKeyboard =
    keyboardItems.find(i => i.id === page && i.show) ?? keyboardItems.find(i => i.show)!;
  const activeSettings =
    settingsItems.find(i => i.id === settingsPage && i.show) ?? settingsItems.find(i => i.show)!;
  const current =
    rail === 'keyboard' ? activeKeyboard : rail === 'settings' ? activeSettings : null;

  const pageBody = () => {
    if (profile === null) return <div className="drv-notice">Connecting…</div>;
    const props = { driver, profile, busy: !!busy, run };
    if (rail === 'help') return <HelpPage driver={driver} />;
    if (rail === 'settings') {
      switch (activeSettings.id) {
        case 'general':
          return <GeneralSettingsPage {...props} />;
        case 'profiles':
          return <ProfilesSettingsPage {...props} />;
        case 'switches':
          return <SwitchesPage driver={driver} model={model} sw={sw} busy={!!busy} run={run} />;
        case 'calibration':
          return <CalibrationSettingsPage driver={driver} model={model} busy={!!busy} run={run} />;
        default:
          return (
            <DevicePage
              driver={driver}
              busy={!!busy}
              run={run}
              onLayoutConfirmed={() => setLayoutConfirmed(n => n + 1)}
            />
          );
      }
    }
    switch (activeKeyboard.id) {
      case 'quick':
        return <DriverQuickPage {...props} state={actuation} perf={perf} sw={sw} />;
      case 'actuation':
        return <DriverActuationPage {...props} state={actuation} perf={perf} hall={hall} sw={sw} />;
      case 'rapid':
        return <DriverRapidPage {...props} state={actuation} perf={perf} />;
      case 'stream':
        return <DriverStreamPage driver={driver} perf={perf} hall={hall} />;
      case 'advanced':
        return <AdvancedKeysPage {...props} model={model} />;
      case 'macros':
        return (
          <MacroPage
            localLibrary={{
              assignHint: 'To play a macro, assign it to a key in Advanced Keys → Add Macro.'
            }}
          />
        );
      case 'lighting':
        return <LightingPage driver={driver} model={model} />;
      case 'gamepad':
        return <GamepadPage {...props} model={model} />;
      default:
        return <RemapPage {...props} model={model} />;
    }
  };

  // OpenAula's pages lay themselves out inside the workspace; OpenHE's own
  // pages get the content column.
  const openAulaPage =
    (rail === 'keyboard' &&
      ['quick', 'actuation', 'rapid', 'stream', 'macros', 'lighting'].includes(
        activeKeyboard.id
      )) ||
    (rail === 'settings' && activeSettings.id === 'switches');

  // Live travel only runs on the pages that show it.
  const hallPage = rail === 'keyboard' && ['actuation', 'stream'].includes(activeKeyboard.id);
  const { stop: stopHall } = hall;
  useEffect(() => {
    if (!hallPage) void stopHall();
  }, [hallPage, stopHall]);

  const sidebarTitle =
    rail === 'keyboard' ? 'Keyboard Configuration' : rail === 'settings' ? 'Settings' : 'Help';

  return (
    <div className={`app-shell drv-app ${compact ? 'is-sidebar-compact' : ''}`}>
      <aside className="rail">
        <div className="brand-mark">
          <img src={logo} alt={BRAND.displayName} />
        </div>
        <div className="rail-stack">
          <RailItem
            icon={<Keyboard size={22} />}
            label="Keyboard"
            active={rail === 'keyboard'}
            onClick={() => setRail('keyboard')}
          />
          <RailItem
            icon={<Settings size={22} />}
            label="Settings"
            active={rail === 'settings'}
            onClick={() => setRail('settings')}
          />
          <RailItem
            icon={<CircleHelp size={22} />}
            label="Help"
            active={rail === 'help'}
            onClick={() => setRail('help')}
          />
        </div>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-title">
          <strong>{sidebarTitle}</strong>
          <button
            type="button"
            className="icon-button compact"
            aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCompact(c => !c)}
          >
            {compact ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <div className="device-panel is-connected">
          <div className="device-card device-card-static">
            <span className="device-thumb drv-device-thumb">
              <BoardThumb layout={driver.layout} />
            </span>
            <span className="device-copy">
              <small>
                <span className="device-status-dot" aria-hidden="true" />
                Connected
              </small>
              <strong className="drv-device-name" title={driver.info.name}>
                {driver.info.name}
              </strong>
              <small className="drv-device-meta">
                {FAMILY_NAME[driver.id] ?? driver.id} · fw {driver.info.firmwareVersion}
              </small>
            </span>
          </div>
          <div className="device-controls">
            {caps.profiles > 1 && (
              <div className="profile-slot-row">
                <span>Profile</span>
                <div className="profile-slot-buttons" role="group" aria-label="Profile">
                  {Array.from({ length: caps.profiles }, (_, i) => (
                    <button
                      type="button"
                      key={i}
                      className={profile === i ? 'is-active' : ''}
                      aria-pressed={profile === i}
                      disabled={!!busy || profile === null}
                      onClick={() => void selectProfile(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              className="device-connect-button is-connected"
              disabled={!!busy}
              onClick={() => void driverConnection.disconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>

        {rail === 'keyboard' && (
          <>
            {profileItems.some(i => i.show) && (
              <>
                <div className="sidebar-section-label">Profiles</div>
                {profileItems
                  .filter(i => i.show)
                  .map(i => (
                    <SidebarItem
                      key={i.id}
                      icon={i.icon}
                      label={i.label}
                      active={activeKeyboard.id === i.id}
                      onClick={() => setPage(i.id)}
                    />
                  ))}
              </>
            )}
            <div className="sidebar-section-label">Keyboard Configuration</div>
            {keyboardItems
              .filter(i => i.show && !profileItems.includes(i))
              .map(i => (
                <SidebarItem
                  key={i.id}
                  icon={i.icon}
                  label={i.label}
                  active={activeKeyboard.id === i.id}
                  onClick={() => setPage(i.id)}
                />
              ))}
          </>
        )}
        {rail === 'settings' && (
          <>
            <div className="sidebar-section-label">Keyboard settings</div>
            {settingsItems
              .filter(i => i.show)
              .map(i => (
                <SidebarItem
                  key={i.id}
                  icon={i.icon}
                  label={i.label}
                  active={activeSettings.id === i.id}
                  onClick={() => setSettingsPage(i.id)}
                />
              ))}
          </>
        )}
        {rail === 'help' && (
          <div className="help-sidebar-copy">
            <p>Connecting, saving, and what each setting does.</p>
          </div>
        )}
        <div className="sidebar-version">
          {BRAND.displayName} <span>v{uiVersion} UI</span>
        </div>
      </aside>

      <main className={`workspace ${rail === 'settings' ? 'workspace-settings' : ''}`}>
        <header className="topbar">
          <div className="profile-control-wrap">
            <div className="page-title-bar">
              <span className="profile-icon">
                {current?.icon ?? <SlidersHorizontal size={17} />}
              </span>
              <strong>{current?.label ?? 'Help'}</strong>
              {rail === 'keyboard' && profile !== null && caps.profiles > 1 && (
                <kbd className="woot-shortcut-pill">Profile {profile + 1}</kbd>
              )}
            </div>
          </div>
          <div className="topbar-actions">
            {(busy || status) && (
              <span className={`profile-status drv-status${status ? ` is-${status.kind}` : ''}`}>
                {busy ? (
                  <>
                    <Loader2 size={14} className="drv-spin" /> {busy}…
                  </>
                ) : (
                  status?.text
                )}
              </span>
            )}
            <span ref={setSaveSlot} className="drv-save-slot" />
          </div>
        </header>
        <SaveSlotContext.Provider value={saveSlot}>
          {openAulaPage ? pageBody() : <div className="drv-content">{pageBody()}</div>}
        </SaveSlotContext.Provider>
      </main>
    </div>
  );
}
