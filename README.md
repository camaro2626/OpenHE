# OpenHE

An open, browser-based configurator for **magnetic (Hall-effect and TMR) keyboards**. Plug a keyboard in, open the page in Chrome or Edge, and set actuation, rapid trigger, key remaps, advanced keys, macros and lighting from a picture of your own board. Nothing to install, no account, no telemetry: the page talks only to your keyboard.

**Use it at [camaro2626.github.io/OpenHE](https://camaro2626.github.io/OpenHE/)** (Chrome, Edge or another Chromium browser on a desktop).

OpenHE grew out of [OpenAula](https://github.com/shizunavn/OpenAula) and keeps its interface, adding a driver layer so one app can serve keyboards from different firmware families.

![OpenHE start screen](docs/images/openhe-start.png)

> **Unofficial project.** OpenHE is a community effort built on open firmware and reverse engineering. It is not affiliated with or endorsed by RongYuan, AULA, or any keyboard maker.

## Contents

- [Supported keyboards](#supported-keyboards)
- [Features](#features)
- [Quick start](#quick-start)
- [Help test a board](#help-test-a-board)
- [How it works](#how-it-works)
- [AULA keyboards (OpenAula)](#aula-keyboards-openaula)
- [Development](#development)
- [Project structure](#project-structure)
- [Credits and license](#credits-and-license)

## Supported keyboards

| Family | Boards | Status |
| --- | --- | --- |
| **OpenHE firmware** | Keyboards running OpenHE's own firmware, built on [libhmk](https://github.com/peppapighs/libhmk) (see [gk68tmr_firmware](https://github.com/camaro2626/gk68tmr_firmware)), starting with the Skyloong GK68 TMR. The board reports its own layout, so no per-board setup is needed. It is not hmkconf-compatible: the firmware has its own actuation model (0.01 mm steps, dead zones, OpenAula-style rapid trigger) and its own HID usage page. | Keymap, actuation, rapid trigger, dead zones, advanced keys, macros, switch profiles, live travel, calibration, gamepad |
| **RongYuan** | About 770 magnetic boards on RongYuan firmware, sold under Akko, MonsGeek, AttackShark, Epomaker, Hator, Ajazz, YUNZII and many other names. Board list, layouts and protocol from [sharkfin](https://github.com/dniminenn/sharkfin). | Keymap, Fn layer, macros, lighting and board settings on all of them; switch settings and SOCD / dynamic keystroke / tap-hold / toggle read on all, **written** on the ry5088 and yc3121 firmware lines (the ones whose write path is verified) |
| **Sparklink** (early) | About 550 USB ids on Sparklink's (星闪悦动) magnetic-keyboard firmware, protocol v2: IROK, EWEADN, CAROTMAS, Everglide SU75 Pro, Weikav EG75 HE, AULA AG75, Wuque Studio and many more. Ported from Sparklink's own MIT-licensed protocol source. | Keymap (4 layers), actuation, rapid trigger (continuous or not), release point, dead zones, live travel, profiles, report rate, SOCD (4 rules) / DKS / tap-hold / toggle, macros (16 shared slots), lighting (20 effects, brightness, speed, direction, colour, on/off, edge strip, per-key colours). The vendor's other advanced keys (MPT, END, RS ...) are kept as set. |
| **AULA** | HERO 68, HERO 84, HERO 68 XS, WIN 68 HE MAX | Through the original OpenAula app, linked from the start screen |

RongYuan boards are identified by the ID the board reports, not by USB product ID (many unrelated boards share `3151:5030`). A board missing from the list is reported as such; nothing is guessed.

Sparklink boards are only ever talked to when their USB id is on Sparklink's own keyboard list: the protocol's first request means something else to other vendors' firmware (a reset on SteelSeries' Apex Pro), so a vendor usage page alone is never enough. The board then describes itself: name, firmware, features and its key layout.

## Features

| Area | What you can do |
| --- | --- |
| Quick Settings, Actuation, Rapid Trigger | OpenAula's own pages: per-key or multi-key actuation point, rapid trigger, top and bottom dead zones (where the board has them), with live Visual Feedback, in 0.01 mm steps |
| Rapid Trigger | On/off per key, one sensitivity or separate press and release sensitivities, continuous rapid trigger on OpenHE firmware |
| Key Remap | Every layer, from a picture of your board; the catalog is filtered to what the board can store, plus board-specific keys (layers, profiles, bootloader …) |
| Actuation extras | Release point with Rapid Trigger off (RongYuan) |
| Advanced Keys | Null bind / SOCD, dynamic keystroke (4 keycodes × 4 stages), tap-hold, toggle and macros, shown with OpenAula's key icons. OpenHE firmware: 5 SOCD rules and bottom-out override. RongYuan (base layer, as the firmware stores them): SOCD as last-pressed-wins, dynamic keystroke with its own first point and one tap or press-and-release per keycode, tap-hold up to 2.55 s, plain or repeating toggle |
| Macros | OpenAula's macro editor (record, edit timing, import/export); macros are kept on your computer and put on keys from Advanced Keys. Played once, N times, while held, or toggled. OpenHE firmware stores 128 steps per profile; RongYuan boards hold 50 macros of up to 250 bytes |
| Lighting | RongYuan: the board's own effect list (from the vendor's light table), brightness, speed, direction, colour or rainbow, the edge light where there is one, and backlight off on yc500 boards. Sparklink: 20 effects, brightness and speed in percent, palette colour, on/off and edge strip. Both: per-key colours painted on the board's picture (Sparklink reads them back and paints on top of any effect; RongYuan cannot read them back, so OpenHE remembers the last pattern per board) |
| General Settings | RongYuan: debounce, wireless sleep and deep-sleep timers (set over the cable, used on 2.4 GHz / Bluetooth), Windows key lock and WASD/arrow swap (yc500), system auto-detect; OpenHE firmware: polling rate, gamepad interface, advanced key timing |
| Gamepad | The firmware's XInput gamepad (OpenHE firmware): per-key button map, analog curve and stick options |
| Hall Stream | OpenAula's live travel page: every key's travel in mm (polled on OpenHE firmware, streamed by cable on RongYuan gen2) |
| Switch Selector | OpenAula's switch selector: tell the board which switch each key has. On OpenHE firmware up to 4 switch types at once, each with its own travel and curve, so mixed switches (e.g. Gravastar UFO and Skyloong Crystal Blue) read correct millimetres; on RongYuan boards the vendor's switch models where the board lists them |
| Device | Firmware version, layout source, recalibration, factory reset; confirming an inferred RongYuan layout before writes |
| Profiles | Every on-board profile the board has; RongYuan switch settings follow the active profile, as the firmware stores them |

![Advanced keys](docs/images/openhe-advanced-keys.png)

![Lighting on a RongYuan board](docs/images/openhe-lighting.png)

## Quick start

1. Open **[camaro2626.github.io/OpenHE](https://camaro2626.github.io/OpenHE/)** in **Chrome or Edge** on a desktop (WebHID is not available in Firefox or Safari).
2. Plug the keyboard in **by cable** and click **Connect keyboard**.
3. Pick the keyboard in the browser's list. Close the vendor's own software first: only one app can own the settings channel at a time.
4. Change settings and press **Save to keyboard** (lighting is written as you change it).

The browser remembers the keyboard, so next time the page reconnects by itself.

No keyboard to hand? **Sparklink demo** and **RongYuan demo** on the start screen open the app on a board in software (a generic 75 % Sparklink board, and RongYuan's AttackShark X65HE with its own picture), running the real drivers. Everything works, live travel included; settings last until you leave the page. They work in any browser.

On Linux the keyboard's HID node belongs to root; add a udev rule (sharkfin's [README](https://github.com/dniminenn/sharkfin#install) has one covering RongYuan vendor IDs) and replug.

### Running from source

It needs **Node.js 22.12 or later**:

```sh
git clone https://github.com/camaro2626/OpenHE.git
cd OpenHE
npm ci
npm run dev
```

Open the HTTPS address Vite prints and accept the local certificate warning (WebHID needs a secure page).

## Help test a board

OpenHE is new and has mostly been checked against software models of the protocols. Reports from real boards are the most useful thing right now:

- **RongYuan owners:** does the picture match your board (Device page)? Do actuation and remap changes take effect and survive a replug? On the Lighting page, does Rainbow give a rainbow (if it gives a solid colour, say whether the "swapped" switch fixes it) and does the speed slider go the right way? Does a macro key play, and do the sleep timers stick? Include the name shown in the sidebar and the firmware version.
- **GK68 owners on OpenHE firmware:** whether actuation, rapid trigger and the dead zones feel the way the sliders say, and whether macros play in each mode.

Open an issue on this repository with what you saw.

## How it works

Each keyboard family is a **driver** in `src/drivers/` behind one interface (`KeyboardDriver`). A driver reports what the board can do (`capabilities`: profiles, layers, travel range and step, which advanced keys, live travel, gamepad …) and its layout; the UI shows only what the board supports and always works in millimetres and one shared keycode space.

- `src/drivers/openhe/` speaks the OpenHE firmware's raw HID protocol (usage page `0xFF48`, libhmk's command set with OpenHE's actuation records). The board identifies itself with an `OPHE` signature; name, sizes, layout and default keymap come from its own metadata.
- `src/drivers/rongyuan/` is a TypeScript port of sharkfin's protocol: 64-byte feature reports on `0xFFFF`, both command families (gen2 and yc500), the magnetic switch columns, write pacing and the 2.4 GHz receiver relay. It writes only what sharkfin writes, with the same spacing between flash writes. `scripts/rongyuan-boards.py` regenerates the bundled board list and light tables from a sharkfin checkout.
- `src/drivers/sparklink/` speaks Sparklink's protocol v2 (64-byte reports on usage page `0xFFB0`), ported from the vendor's own MIT-licensed source (`LICENSES/MIT-sparklink.txt`). Firmware-upgrade commands are left out.
- `src/driverApp/` is the workspace UI for driver-backed boards. The connected board is registered as an OpenAula board model, so OpenAula's own Quick Settings, Actuation Point, Rapid Trigger, Hall Stream, Switch Selector and Macros pages and keyboard preview draw it.

The drivers are tested in `tests/openhe-driver.test.mjs`, `tests/rongyuan-driver.test.mjs` and `tests/sparklink-driver.test.mjs` against software boards built from the firmware sources and protocol notes.

## AULA keyboards (OpenAula)

The AULA app from OpenAula is still here, unchanged, behind the **AULA keyboards** card on the start screen (the choice is remembered; **OpenHE home** in its device panel goes back). For AULA boards, the Windows tray service, Custom Effects, Rhythm Sync and the AULA documentation, see [OpenAula](https://github.com/shizunavn/OpenAula) itself.

## Development

Production builds and tests require development dependencies. Use `npm ci` (or
`npm ci --include=dev` if your environment defaults to omitting them) before
building; the resulting `dist/` contains static browser assets.

Copy `.env.example` to `.env.local` to configure `HERO68_DEV_HOSTS`: optional
comma-separated hostnames/IPs added to the local Vite certificate. Localhost and
127.0.0.1 remain available without configuration.

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server over HTTPS |
| `npm run build` | Type-check and build the web app into `dist/` (serve it over HTTPS for WebHID) |
| `npm run preview` | Preview the production build |
| `npm test` | Run all tests (`node --test tests/*.test.mjs`) |
| `npm run lint` | ESLint |

Set `OPENHE_BASE` when building for a sub-path (`OPENHE_BASE=/OpenHE/ npm run build` is what GitHub Pages uses).

Tech stack: React 19, TypeScript 7, Vite 8, WebHID.

### Deployment (GitHub Pages)

`.github/workflows/pages.yml` runs the tests, builds with the repository name as the base path and publishes `dist/` to GitHub Pages on every push to `main` (or by hand from the Actions tab). In a fork, enable it once under **Settings → Pages → Build and deployment → Source: GitHub Actions**.

OpenAula's Cloudflare deployment, Windows tray service and landing site are still in the tree (`functions/`, `worker/`, `service/`, `landing/`) for the AULA app, but OpenHE does not deploy them; the Cloudflare workflow only runs in the upstream OpenAula repository. See [OpenAula](https://github.com/shizunavn/OpenAula) for building those.

## Project structure

```text
src/
  Root.tsx           Picks the start screen, the driver workspace or the AULA app
  drivers/           Board-neutral driver layer
    types.ts         KeyboardDriver interface and capabilities
    keycodes.ts      Shared UI keycode space
    openhe/          OpenHE firmware driver
    rongyuan/        RongYuan driver (sharkfin port) and bundled board list/layouts
    sparklink/       Sparklink driver (vendor protocol v2 port) and its keyboard id list
    demo/            Demo boards for the start screen (Sparklink, RongYuan) in software
  driverApp/         OpenHE workspace: shell, pages, start screen
  App.tsx, app/, pages/, components/, keyboard/, protocol/, state/
                     The OpenAula app (AULA boards)
  styles/            Shared stylesheets (13-driver.css for the workspace)
tests/               Test suite, including the driver tests
service/, landing/, functions/, worker/
                     OpenAula's Windows service, landing site and Cloudflare deployment
```

## Credits and license

- [OpenAula](https://github.com/shizunavn/OpenAula) by shizunavn: the app, interface and AULA support this project started from (Apache-2.0, see `LICENSES/Apache-2.0.txt`).
- [sharkfin](https://github.com/dniminenn/sharkfin) by JR Lanteigne: the RongYuan protocol, board list and layouts the RongYuan driver is ported from (GPL-3.0-or-later).
- [libhmk](https://github.com/peppapighs/libhmk) by peppapighs: the firmware OpenHE's firmware is built on.
- [Sparklink / 星闪悦动](https://github.com/sparklinkplayjoy/keyboard-docs): the keyboard protocol and key names the Sparklink driver is ported from (MIT, `LICENSES/MIT-sparklink.txt`).
- [HallJoy](https://github.com/PashOK7/HallJoy) by PashOK7: the research behind the Sparklink keyboard id list and its safety rules.
- [device-hub](https://github.com/pity-zxcv/device-hub) by pity-zxcv (MIT / Apache-2.0): hardware-checked Sparklink notes (SU66 Max) that the Sparklink DKS bits, lighting scales and effect list follow.

OpenHE as a whole is distributed under the **GNU General Public License v3.0 or later** (`LICENSE`). Files carried over from OpenAula remain available under Apache-2.0 as well.
