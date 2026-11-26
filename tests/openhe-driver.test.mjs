import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}

const { OpenHEDriver, layoutFromMetadata } = await bundle('src/drivers/openhe/driver.ts')
const kc = await bundle('src/drivers/openhe/keycodes.ts')
const ui = await bundle('src/drivers/keycodes.ts')

const metadataJson = readFileSync('tests/fixtures/openhe-gk68-metadata.json')
const metadata = JSON.parse(metadataJson)

/**
 * An OpenHE board in software, following gk68tmr_firmware src/commands.c:
 * same struct layouts, same COMMAND_VERIFY checks, same staged-write rules.
 */
function fakeOpenHE(md = metadata, opts = {}) {
  const gz = gzipSync(Buffer.from(JSON.stringify(md)))
  const N = md.numKeys, P = md.numProfiles, L = md.numLayers
  const dks = md.numDynamicKeystrokeMaxBindings
  const akSize = 3 + Math.max(3, 2 * dks + 1, 5)
  const profiles = Array.from({ length: P }, () => ({
    keymap: Array.from({ length: L }, () => new Uint8Array(N)),
    actuation: (() => { const a = new Uint8Array(N * 9); for (let k = 0; k < N; k++) a.set([200, 0, 30, 0, 30, 0, 10, 10, 1], k * 9); return a })(),
    advanced: new Uint8Array(akSize * md.numAdvancedKeys),
    macros: new Uint8Array(4 * md.numMacroNodes),
    gamepad: new Uint8Array(N),
    gpOptions: Uint8Array.from([4, 20, 85, 95, 165, 170, 255, 255, 0b1001]),
    tick: 30
  }))
  const staged = { id: 0, profile: 0, offset: 0, buf: new Uint8Array(akSize) }
  // libhmk's command_stage_write: whole items only, in order, per staged id
  const stagedWrite = (req, id, field, item) => {
    const prof = req[1]
    const off = req[2] | (req[3] << 8), len = req[4]
    if (off + len > field.length || len > 59 || len === 0) return false
    if (off % item === 0) Object.assign(staged, { id, profile: prof, offset: off })
    if (staged.id !== id || staged.offset !== off || staged.profile !== prof) return false
    for (let i = 0; i < len;) {
      const cur = staged.offset % item
      const w = Math.min(len - i, item - cur)
      staged.buf.set(req.subarray(5 + i, 5 + i + w), cur)
      if (len - i >= item - cur) field.set(staged.buf.subarray(0, item), staged.offset - cur)
      staged.offset += w; i += w
    }
    return true
  }
  const stagedRead = (out, field, off) => {
    if (off >= field.length) return false
    const len = Math.min(62, field.length - off)
    out[1] = len
    out.set(field.subarray(off, off + len), 2)
    return true
  }
  const log = []
  const session = { active: false, done: new Set() }
  const cal = { rest: 4095, bottom: 500 }
  let switchProfiles = Array.from({ length: 4 }, () => [0, 400 & 0xff, 400 >> 8, 15])
  const keySwitch = new Uint8Array(N)
  let options = 0b100
  const u16 = v => [v & 0xff, (v >> 8) & 0xff]
  const handle = req => {
    const cmd = req[0]
    const out = new Uint8Array(64)
    out[0] = cmd
    const fail = () => { out[0] = 0xff; return out }
    const p = profiles[req[1]]
    switch (cmd) {
      case 0: out[1] = 0x08; out[2] = 0x01; break
      case 8: out[1] = 2; break
      case 13: {
        const off = req[1] | (req[2] << 8) | (req[3] << 16) | (req[4] << 24)
        if (off >= gz.length) return fail()
        const len = gz.length - off
        out.set([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, len >>> 24], 1)
        out.set(gz.subarray(off, off + Math.min(59, len)), 5)
        break
      }
      case 14: out.set(Buffer.from('GK68-TEST'), 1); break
      case 16: if (opts.notOpenHE) return fail(); out.set([0x4f, 0x50, 0x48, 0x45, 1, 0, 0x08, 0x01, 400 & 0xff, 400 >> 8, 7 | 16 | (opts.guided ? 32 : 0), 0, 0, 0], 1); break
      case 5: {
        const off = req[1]; if (off >= N) return fail()
        for (let i = 0; i < 15 && off + i < N; i++) {
          const v = 2600 + off + i, t = (off + i) * 5
          out.set([v & 0xff, v >> 8, t & 0xff, t >> 8], 1 + i * 4)
        }
        break
      }
      case 128: {
        const [, prof, layer, off] = req
        if (prof >= P || layer >= L || off >= N) return fail()
        out.set(profiles[prof].keymap[layer].subarray(off, off + 63), 1)
        break
      }
      case 129: {
        const [, prof, layer, off, len] = req
        if (prof >= P || layer >= L || off >= N || len > 59 || len > N - off) return fail()
        profiles[prof].keymap[layer].set(req.subarray(5, 5 + len), off)
        break
      }
      case 130: {
        const [, prof, off] = req
        if (prof >= P || off >= N) return fail()
        out.set(p.actuation.subarray(off * 9, (off + 6) * 9), 1)
        break
      }
      case 131: {
        const [, prof, off, len] = req
        if (prof >= P || off >= N || len > 6 || len > N - off) return fail()
        for (let i = 0; i < len; i++) {
          const o = 4 + i * 9, ap = req[o] | (req[o + 1] << 8)
          if (ap < 1 || ap > 400) return fail()
        }
        profiles[prof].actuation.set(req.subarray(4, 4 + len * 9), off * 9)
        break
      }
      case 132: if (req[1] >= P || !stagedRead(out, p.advanced, req[2] | (req[3] << 8))) return fail(); break
      case 133: if (req[1] >= P || !stagedWrite(req, 1, profiles[req[1]].advanced, akSize)) return fail(); break
      case 140: if (req[1] >= P || !stagedRead(out, p.macros, req[2] | (req[3] << 8))) return fail(); break
      case 141: if (req[1] >= P || !stagedWrite(req, 2, profiles[req[1]].macros, 4)) return fail(); break
      case 4: log.push('recalibrate'); break
      case 6: out.set([...u16(cal.rest), ...u16(cal.bottom)], 1); break
      case 7: cal.rest = req[1] | (req[2] << 8); cal.bottom = req[3] | (req[4] << 8); break
      case 9: out.set(u16(options), 1); break
      case 10: options = req[1] | (req[2] << 8); break
      case 11: if (req[1] >= P) return fail(); log.push(`reset ${req[1]}`); break
      case 12: if (req[1] >= P || req[2] >= P) return fail(); log.push(`dup ${req[2]}->${req[1]}`); break
      case 15: log.push('save-cal'); break
      case 21: {
        if (req[1] === 1) { session.active = true; session.done.clear(); log.push('cal-start') }
        else if (req[1] === 2) { session.active = false; log.push('cal-finish') }
        out[1] = session.active ? 1 : 0
        for (const k of session.done) out[2 + (k >> 3)] |= 1 << (k & 7)
        break
      }
      case 17: out[1] = 4; switchProfiles.forEach((p, i) => out.set(p, 2 + i * 4)); break
      case 18: {
        if (req[1] !== 4) return fail()
        const next = [0, 1, 2, 3].map(i => [...req.subarray(2 + i * 4, 6 + i * 4)])
        if (next.some(p => (p[1] | (p[2] << 8)) < 100 || (p[1] | (p[2] << 8)) > 1000 || p[3] > 250)) return fail()
        switchProfiles = next
        break
      }
      case 19: if (req[1] >= N) return fail(); out.set(keySwitch.subarray(req[1], req[1] + 63), 1); break
      case 20: {
        const [, off, len] = req
        if (off >= N || len > 60 || len > N - off || [...req.subarray(3, 3 + len)].some(v => v >= 4)) return fail()
        keySwitch.set(req.subarray(3, 3 + len), off)
        break
      }
      case 134: if (req[1] >= P) return fail(); out[1] = p.tick; break
      case 135: if (req[1] >= P) return fail(); p.tick = req[2]; break
      case 136: {
        const [, prof, off] = req
        if (prof >= P || off >= N) return fail()
        out.set(p.gamepad.subarray(off, off + 63), 1)
        break
      }
      case 137: {
        const [, prof, off, len] = req
        if (prof >= P || off >= N || len > 60 || len > N - off) return fail()
        profiles[prof].gamepad.set(req.subarray(4, 4 + len), off)
        break
      }
      case 138: if (req[1] >= P) return fail(); out.set(p.gpOptions, 1); break
      case 139: if (req[1] >= P) return fail(); profiles[req[1]].gpOptions = req.slice(2, 11); break
      default: return fail()
    }
    return out
  }
  const transport = {
    sent: 0,
    async exchange(report) {
      assert.equal(report.length, 64)
      this.sent++
      return handle(report)
    },
    async close() {}
  }
  return { transport, profiles, log, akSize, cal, keySwitch, session, get switchProfiles() { return switchProfiles }, get options() { return options } }
}

const usb = { vendorId: 0x3151, productId: 0x5030, productName: 'GK68' }

test('connect reads version, serial and the gzipped metadata', async () => {
  const { transport } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  assert.equal(d.info.name, 'GK68')
  assert.equal(d.info.firmwareVersion, '1.8')
  assert.equal(d.id, 'openhe')
  assert.equal(d.info.serial, 'GK68-TEST')
  assert.equal(d.capabilities.profiles, 4)
  assert.equal(d.capabilities.layers, 4)
  assert.equal(d.capabilities.maxAdvancedKeys, 32)
  assert.deepEqual(d.capabilities.pollingRates, [8000, 1000])
  assert.equal(d.layout.keys.length, 68)
})

test('layout comes from the metadata, legends from the default keymap', () => {
  const layout = layoutFromMetadata(metadata)
  const byIndex = i => layout.keys.find(k => k.index === i)
  assert.equal(byIndex(0).label, 'Esc')
  assert.equal(byIndex(13).label, 'Bksp')
  assert.equal(byIndex(13).w, 2)
  assert.equal(byIndex(14).x, 15) // Ins after 13 1U keys + 2U backspace
  assert.equal(byIndex(61).label, 'Space')
  assert.equal(byIndex(61).w, 6.25)
  assert.equal(byIndex(63).label, 'Fn') // MO(1)
  assert.equal(layout.width, 16)
  assert.equal(layout.height, 5)
})

test('keymap round-trips through the board in UI keycodes', async () => {
  const { transport, profiles } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  const def = d.defaultKeymap(0)
  assert.equal(def.length, 68)
  assert.equal(def[0], 0x29) // Esc as HID usage
  assert.equal(def[16], 0x14) // Q
  assert.equal(def[63], ui.uiMomentaryLayer(1))
  await d.setKeymap(1, 0, def)
  assert.equal(profiles[1].keymap[0][0], 0x27) // KC_ESCAPE
  assert.equal(profiles[1].keymap[0][63], 0xc1) // MO(1)
  assert.deepEqual(await d.getKeymap(1, 0), def)

  const fn = d.defaultKeymap(1)
  assert.equal(fn[52], ui.uiConsumer(0xea)) // Fn+, = volume down
  assert.equal(fn[16], ui.uiNative(0x01)) // transparent stays native
  await d.setKeymap(0, 1, fn)
  assert.deepEqual(await d.getKeymap(0, 1), fn)
})

test('keycodes the board cannot express are refused before anything is written', async () => {
  const { transport, profiles } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  const map = d.defaultKeymap(0)
  map[5] = 0x10600 // Ctrl+C combo: the firmware has no combos
  await assert.rejects(d.setKeymap(0, 0, map), /not available on this keyboard/)
  assert.equal(profiles[0].keymap[0][0], 0)
})

test('actuation uses OpenAula fields, stored in 0.01 mm with flags', async () => {
  const { transport, profiles } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  assert.equal(d.capabilities.travelMm, 4)
  assert.equal(d.capabilities.travelStepMm, 0.01)
  assert.equal(d.capabilities.topDeadzone, true)
  assert.equal(d.capabilities.continuousRapidTrigger, true)
  const before = await d.getActuation(0)
  assert.equal(before.length, 68)
  assert.deepEqual(before[0], {
    actuationMm: 2, rapidTrigger: true, splitSensitivity: false, rtPressMm: 0.3, rtReleaseMm: 0.3,
    continuous: false, deadzoneEnabled: false, topDeadzoneMm: 0.1, bottomDeadzoneMm: 0.1
  })
  const next = before.map((a, i) => i === 40
    ? { ...a, actuationMm: 0.45, splitSensitivity: true, rtPressMm: 0.12, rtReleaseMm: 0.35, continuous: true, deadzoneEnabled: true, topDeadzoneMm: 0.2, bottomDeadzoneMm: 0.35 }
    : { ...a, actuationMm: 1.2, rapidTrigger: false })
  await d.setActuation(2, next)
  const raw = profiles[2].actuation
  assert.deepEqual([...raw.subarray(40 * 9, 41 * 9)], [45, 0, 12, 0, 35, 0, 20, 35, 0x01 | 0x02 | 0x04 | 0x08])
  // RT off keeps the sensitivities
  assert.deepEqual([...raw.subarray(0, 9)], [120, 0, 30, 0, 30, 0, 10, 10, 0])
  const back = await d.getActuation(2)
  assert.deepEqual(back[40], next[40])
  assert.equal(back[0].rapidTrigger, false)
  assert.equal(back[0].rtPressMm, 0.3)
  // values past full travel are clamped, never refused by the board
  await d.setActuation(2, next.map(a => ({ ...a, actuationMm: 9, rtPressMm: 0 })))
  assert.equal(raw[0] | (raw[1] << 8), 400)
  await d.setActuation(2, next.map(a => ({ ...a, actuationMm: 0 })))
  assert.equal(raw[0] | (raw[1] << 8), 1)
})

test('boards without OpenHE firmware are refused', async () => {
  const { transport } = fakeOpenHE(metadata, { notOpenHE: true })
  await assert.rejects(OpenHEDriver.connect(transport, usb), /not running OpenHE firmware/)
})

test('advanced keys survive the staged write protocol', async () => {
  const { transport, profiles, akSize } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  assert.equal(akSize, 12)
  const keys = [
    { kind: 'nullBind', layer: 0, key: 31, secondaryKey: 33, behavior: 'last', bottomOutMm: 0 },
    { kind: 'tapHold', layer: 0, key: 30, tap: 0x29, hold: 0x10000, tappingTermMs: 200, holdOnOtherKeyPress: true },
    { kind: 'toggle', layer: 1, key: 2, keycode: 0x1e, tappingTermMs: 180 },
    {
      kind: 'dynamicKeystroke', layer: 0, key: 16, keycodes: [0x14, 0x1a, 0, 0],
      actions: [['press', 'hold', 'release', 'tap'], ['tap', 'tap', 'tap', 'tap'], ['hold', 'hold', 'hold', 'hold'], ['hold', 'hold', 'hold', 'hold']],
      bottomOutMm: 3.5
    },
    {
      kind: 'macro', layer: 0, key: 5, mode: 'repeat', repeat: 3,
      steps: [
        { keycode: 0x10000, action: 'press', delayMs: 0 },
        { keycode: 0x06, action: 'tap', delayMs: 25 },
        { keycode: 0x10000, action: 'release', delayMs: 8191 }
      ]
    },
    {
      kind: 'macro', layer: 1, key: 6, mode: 'toggle', repeat: 1,
      steps: [{ keycode: 0x04, action: 'tap', delayMs: 100 }]
    }
  ]
  await d.setAdvancedKeys(3, keys)
  // the whole 32-entry table was written (staging must commit every item)
  assert.equal(profiles[3].advanced[1 * akSize + 2], 3) // tap-hold type
  const back = await d.getAdvancedKeys(3)
  assert.equal(back.length, 6)
  assert.deepEqual(back[0], keys[0])
  assert.deepEqual(back[1], keys[1])
  assert.deepEqual(back[2], keys[2])
  assert.deepEqual(back[3].actions, keys[3].actions)
  assert.deepEqual(back[3].keycodes, keys[3].keycodes)
  assert.ok(Math.abs(back[3].bottomOutMm - 3.5) < 0.02)
  assert.deepEqual(back[4], keys[4])
  assert.deepEqual(back[5], keys[5])
  // the second macro's nodes follow the first's
  assert.equal(profiles[3].macros[3 * 4], 0x02) // libhmk KC_A
  await assert.rejects(
    d.setAdvancedKeys(3, [{ ...keys[4], steps: Array(129).fill(keys[4].steps[1]) }]),
    /128 macro steps/
  )
  await assert.rejects(d.setAdvancedKeys(0, Array(33).fill(keys[0])), /at most 32/)
})

test('travel readout pages through every key', async () => {
  const { transport, log } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  const before = transport.sent
  const t = await d.readTravel()
  assert.equal(transport.sent - before, 5) // 68 keys / 15 per report
  assert.equal(t.length, 68)
  assert.equal(t[67].raw, 2600 + 67)
  assert.ok(Math.abs(t[67].travelMm - 3.35) < 1e-9)
  await d.recalibrate()
  assert.deepEqual(log, ['recalibrate'])
})

test('a rejected command surfaces as an error', async () => {
  const { transport } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  await assert.rejects(d.getKeymap(9, 0), /out of range/)
  await assert.rejects(d.getKeymap(0, 9), /rejected command 128/)
})

test('transparent is KC_TRANSPARENT, not an empty slot', async () => {
  const { transport } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  assert.equal(kc.uiToHmk(d.transparentKeycode), 0x01)
  assert.equal(kc.uiToHmk(0), 0x00)
})

test('every firmware keycode maps to a UI keycode and back', () => {
  for (let code = 0; code <= 0xd4; code++) {
    if (code > 0x9f && code < 0xc0) continue
    assert.equal(kc.uiToHmk(kc.hmkToUi(code)), code, `0x${code.toString(16)}`)
  }
  assert.equal(kc.hmkToUi(0x02), 0x04) // A
  assert.equal(kc.hmkToUi(0x64), 0x68) // F13
  assert.equal(kc.hmkToUi(0x7b), 0x10000) // LCtrl, as the remap catalog writes it
  assert.equal(kc.hmkToUi(0x82), 0x800000) // RGUI
  assert.equal(kc.uiToHmk(0xe1), 0x7c) // a raw HID modifier usage is still accepted
  assert.equal(kc.hmkToUi(0x9b), 0x01010100) // left mouse, as in the remap catalog
  assert.equal(kc.hmkCodeFromName('MO(2)'), 0xc2)
  assert.equal(kc.hmkCodeFromName('KC_RIGHT_ALT'), 0x81)
})

test('gamepad map, curve and flags round-trip', async () => {
  const { transport, profiles } = fakeOpenHE()
  const d = await OpenHEDriver.connect(transport, usb)
  const gp = await d.getGamepad(1)
  assert.equal(gp.buttons.length, 68)
  assert.ok(gp.buttons.every(b => b === 'none'))
  assert.equal(gp.keyboardEnabled, true)
  assert.equal(gp.snappyJoystick, true)
  assert.equal(gp.gamepadOverride, false)
  assert.ok(Math.abs(gp.curve[1].travelMm - (85 * 4) / 255) < 1e-9)
  assert.ok(Math.abs(gp.curve[1].output - 95 / 255) < 1e-9)

  gp.buttons[17] = 'leftStickUp' // W
  gp.buttons[31] = 'leftStickLeft' // A
  gp.buttons[61] = 'a' // space
  gp.buttons[67] = 'rightTrigger'
  gp.gamepadOverride = true
  gp.curve[2] = { travelMm: 0.5, output: 0.5 } // below point 1: must be pushed up, not left falling
  await d.setGamepad(1, gp)
  const raw = profiles[1].gamepad
  assert.equal(raw[17], 16)
  assert.equal(raw[31], 18)
  assert.equal(raw[61], 1)
  assert.equal(raw[67], 25)
  const o = profiles[1].gpOptions
  assert.equal(o[8], 0b1011)
  assert.ok(o[4] >= o[2], 'curve x never falls')
  const back = await d.getGamepad(1)
  assert.deepEqual(back.buttons, gp.buttons)
  assert.equal(back.gamepadOverride, true)
})

test('options keep reserved bits; calibration, tick rate and profiles', async () => {
  const board = fakeOpenHE()
  const d = await OpenHEDriver.connect(board.transport, usb)
  assert.deepEqual(await d.getOptions(), { xinput: false, highPollingRate: true })
  await d.setOptions({ xinput: true })
  assert.equal(board.options, 0b101)
  await d.setOptions({ highPollingRate: false })
  assert.equal(board.options, 0b001)
  assert.deepEqual(await d.getCalibration(), { initialRest: 4095, initialBottomOutThreshold: 500 })
  await d.setCalibration({ initialRest: 4090, initialBottomOutThreshold: 400 })
  assert.deepEqual(board.cal, { rest: 4090, bottom: 400 })
  await d.saveCalibration()
  assert.equal(await d.getTickRate(0), 30)
  await d.setTickRate(0, 10)
  assert.equal(await d.getTickRate(0), 10)
  await d.resetProfile(2)
  await d.duplicateProfile(3, 0)
  assert.deepEqual(board.log, ['save-cal', 'reset 2', 'dup 0->3'])
})

test('switch profiles: mixed switches pack into firmware profiles, most used first', async () => {
  const board = fakeOpenHE()
  const d = await OpenHEDriver.connect(board.transport, usb)
  assert.equal(d.maxSwitchTypes, 4)
  assert.deepEqual(d.switchCatalog().map(s => s.id), ['generic', 'gravastar-ufo', 'skyloong-crystal-blue'])
  const setup = await d.getSwitchSetup()
  assert.ok(setup.keySwitch.every(id => id === 'generic'))
  assert.deepEqual(setup.tuning.generic, { travelMm: 4, curve: 15 })
  // most keys UFO, a few Crystal Blue with their own travel and curve
  const keySwitch = setup.keySwitch.map((_, i) => (i < 5 ? 'skyloong-crystal-blue' : 'gravastar-ufo'))
  await d.setSwitchSetup({
    keySwitch,
    tuning: { 'gravastar-ufo': { travelMm: 3.5, curve: 12 }, 'skyloong-crystal-blue': { travelMm: 4, curve: 20 } }
  })
  assert.deepEqual(board.switchProfiles[0], [1, 350 & 0xff, 350 >> 8, 12]) // UFO, most used -> profile 0
  assert.deepEqual(board.switchProfiles[1], [2, 400 & 0xff, 400 >> 8, 20])
  assert.equal(board.keySwitch[0], 1)
  assert.equal(board.keySwitch[10], 0)
  const back = await d.getSwitchSetup()
  assert.deepEqual(back.keySwitch, keySwitch)
  assert.deepEqual(back.tuning['gravastar-ufo'], { travelMm: 3.5, curve: 12 })
  // values out of range are clamped, never refused
  await d.setSwitchSetup({ keySwitch, tuning: { 'gravastar-ufo': { travelMm: 20, curve: 999 }, 'skyloong-crystal-blue': { travelMm: 4, curve: 20 } } })
  assert.deepEqual(board.switchProfiles[0], [1, 1000 & 0xff, 1000 >> 8, 250])
  await assert.rejects(d.setSwitchSetup({ keySwitch: keySwitch.map(() => 'nope'), tuning: {} }), /Unknown switch/)
})

test('guided calibration: only on firmware with the feature, key bits by firmware index', async () => {
  const plain = await OpenHEDriver.connect(fakeOpenHE().transport, usb)
  assert.equal(plain.startCalibration, undefined)
  const { transport, log, session } = fakeOpenHE(metadata, { guided: true })
  const d = await OpenHEDriver.connect(transport, usb)
  await d.startCalibration()
  assert.deepEqual(log.slice(-1), ['cal-start'])
  session.done.add(0); session.done.add(9); session.done.add(67)
  const p = await d.calibrationProgress()
  assert.equal(p.length, d.layout.keys.length)
  const lit = d.layout.keys.flatMap((k, i) => (p[i] ? [k.index] : []))
  assert.deepEqual(lit, [0, 9, 67])
  await d.finishCalibration()
  assert.deepEqual(log.slice(-1), ['cal-finish'])
})
