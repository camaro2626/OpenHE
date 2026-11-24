import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path, logLevel: 'silent' })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}

const { SparklinkDriver, isSparklinkDevice, layoutFrom } = await bundle('src/drivers/sparklink/driver.ts')
const { InputReportTransport } = await bundle('src/drivers/transport.ts')
const ui = await bundle('src/drivers/keycodes.ts')

const usb = { vendorId: 0x1ca6, productId: 0x0529, productName: 'MG75 MAX' }
const le = v => [v & 0xff, (v >> 8) & 0xff]

/**
 * A v2 board in software, following @sparklinkplayjoy/protocol-keyboard-v2:
 * replies echo group and sub-command; row commands carry 21 little-endian
 * keycodes; layout style words are row:5 col:7 ratio:4 in quarter units;
 * performance values are micrometres.
 */
function fakeBoard({ magnetic = true, rows = [15, 15, 14, 14, 10], profiles = 4, rates = [0, 1, 3, 6] } = {}) {
  const N_LAYERS = 4
  const state = { profile: 0, rate: 3, writes: [], saves: [], resets: 0 }
  // macros: shared by every profile, 16 slots of up to 60 actions
  const macros = Array.from({ length: 16 }, () => ({ header: [0, 0, 0, 0, 0, 0], actions: new Array(60 * 4).fill(0) }))
  const cfg = Array.from({ length: profiles }, () => ({
    keys: Array.from({ length: N_LAYERS }, () => Array.from({ length: 8 }, () => new Array(21).fill(0))),
    perf: new Map(),
    hk: new Map()
  }))
  // a plain staggered board: every key 1u except the row ends
  const style = Array.from({ length: 8 }, () => new Array(21).fill(0))
  const defaults = Array.from({ length: 8 }, () => new Array(21).fill(0))
  let usage = 0x04
  rows.forEach((n, r) => {
    let x = 0
    for (let c = 0; c < n; c++) {
      const ratio = c === 0 && r > 0 ? 3 : r === 4 && c === 3 ? 9 : 1 // 1.5u first key, a space bar
      const w = { 1: 1, 3: 1.5, 9: 6.25 }[ratio]
      style[r][c] = (((r * 4) & 0x1f) << 11) | (((x * 4) & 0x7f) << 4) | ratio
      x += w
      defaults[r][c] = usage <= 0x63 ? usage++ : 0x2c
      for (const p of cfg) p.keys[0][r][c] = defaults[r][c]
      const perf = { mode: 0, normalPress: 1500, normalRelease: 1200, rtFirstTouch: 300, rtPress: 150, rtRelease: 150,
        pressDead: 0, releaseDead: 0, axis: 3, calibrate: 1, axisV2Id: 0x0102, axisRangeMax: 3800, axisCoefficient: 77 }
      for (const p of cfg) p.perf.set(`${r}:${c}`, { ...perf })
    }
  })
  const route = new Map()
  const reply = req => {
    const out = new Uint8Array(64)
    out[0] = req[0]; out[1] = req[1]
    const p = cfg[state.profile]
    switch ((req[0] << 8) | req[1]) {
      case 0x0102: // device info
        out.set([1, 0x00, 0x16, 0x05, 0x22, 0x01, 1, 2, 3, 4, 1, 0, 0, 0, 0], 2)
        out.set(Buffer.from('2026-11-01'), 29)
        break
      case 0x0103: out.set([magnetic ? 0x02 : 0x01, 0x01, 0x01, 0x00], 2); break
      case 0x0305: { // style row
        out[2] = req[2]
        style[req[2]].forEach((w, i) => out.set(le(w), 3 + i * 2))
        break
      }
      case 0x0301: out[2] = req[2]; out[3] = req[3]; p.keys[req[2]][req[3]].forEach((k, i) => out.set(le(k), 4 + i * 2)); break
      case 0x0302: {
        const [, , layer, row] = req
        for (let i = 0; i < 21; i++) p.keys[layer][row][i] = req[4 + i * 2] | (req[5 + i * 2] << 8)
        state.writes.push(['row', layer, row])
        out[2] = layer; out[3] = row
        break
      }
      case 0x0306: out[2] = req[2]; out[3] = req[3]; defaults[req[3]].forEach((k, i) => out.set(le(k), 4 + i * 2)); break
      case 0x0401: {
        const v = p.perf.get(`${req[2]}:${req[3]}`)
        out[2] = req[2]; out[3] = req[3]
        if (!v) break
        out[4] = v.mode
        ;[v.normalPress, v.normalRelease, v.rtFirstTouch, v.rtPress, v.rtRelease, v.pressDead, v.releaseDead].forEach((x, i) => out.set(le(x), 5 + i * 2))
        out[19] = v.axis; out[20] = v.calibrate
        out.set([...le(v.axisV2Id), ...le(v.axisRangeMax), ...le(v.axisCoefficient)], 21)
        break
      }
      case 0x0402: {
        const u = i => req[i] | (req[i + 1] << 8)
        p.perf.set(`${req[2]}:${req[3]}`, { mode: req[4], normalPress: u(5), normalRelease: u(7), rtFirstTouch: u(9), rtPress: u(11),
          rtRelease: u(13), pressDead: u(15), releaseDead: u(17), axis: req[19], calibrate: req[20], axisV2Id: u(21), axisRangeMax: u(23), axisCoefficient: u(25) })
        state.writes.push(['perf', req[2], req[3]])
        break
      }
      case 0x0403: out[2] = req[2]; out[3] = req[3]; (route.get(req[3]) ?? []).forEach((v, i) => out.set(le(v), 4 + i * 2)); break
      case 0x0201: state.resets++; out[3] = 0xff; break
      case 0x0202: state.saves.push(req[2]); out[3] = req[2]; break
      case 0x0203:
        if (req[2] === 0) out[3] = profiles
        else if (req[2] === 1) out[3] = state.profile
        else { state.profile = req[3]; state.writes.push(['profile', req[3]]); out[3] = req[3] }
        break
      case 0x0205:
        if (req[2] === 0) { out[3] = rates.length; out.set(rates, 4) }
        else if (req[2] === 1) out[3] = state.rate
        else { state.rate = req[3]; out[3] = req[3] }
        break
      case 0x020c: out[3] = 10; break
      case 0x020e: out[3] = 16; out.set(le(960), 4); break
      case 0x0701: out[2] = req[2]; out.set(macros[req[2]].header, 3); break
      case 0x0702: macros[req[2]].header = [...req.subarray(3, 9)]; state.writes.push(['macroHeader', req[2]]); out[2] = req[2]; break
      case 0x0703: out[2] = req[2]; out[3] = req[3]; out.set(macros[req[2]].actions.slice(req[3] * 60, req[3] * 60 + 60), 4); break
      case 0x0704: {
        const m = macros[req[2]]
        for (let i = 0; i < 60; i++) m.actions[req[3] * 60 + i] = req[4 + i]
        state.writes.push(['macroPage', req[2], req[3]])
        out[2] = req[2]; out[3] = req[3]
        break
      }
      case 0x0601: { // read: the stored record, whatever its mode
        out[2] = req[2]; out[3] = req[3]
        const rec = p.hk.get(`${req[2]}:${req[3]}`)
        if (rec) out.set(rec.slice(4), 4)
        break
      }
      case 0x0602: {
        const k = `${req[2]}:${req[3]}`
        if (req[4] === 0) p.hk.delete(k)
        else p.hk.set(k, [...req.subarray(0, 40)])
        state.writes.push(['hk', req[2], req[3], req[4]])
        out[2] = req[2]; out[3] = req[3]; out[4] = req[4]
        break
      }
      default: out[0] = 0xff
    }
    return out
  }
  const transport = {
    sent: [],
    async exchange(req, _t, accept) {
      this.sent.push([...req.subarray(0, 4)])
      const r = reply(req)
      if (accept && !accept(r)) throw new Error('Keyboard did not answer')
      return r
    },
    async close() {}
  }
  return { transport, state, cfg, route, style, macros }
}

test('only listed ids on the 0xFFB0 interface count as Sparklink boards', () => {
  const dev = (vendorId, productId, usagePage = 0xffb0) => ({ vendorId, productId, collections: [{ usagePage, usage: 1 }] })
  assert.equal(isSparklinkDevice(dev(0x1ca6, 0x0529)), true)
  assert.equal(isSparklinkDevice(dev(0x1ca6, 0x0529, 0xff00)), false)
  assert.equal(isSparklinkDevice(dev(0x1038, 0x1612)), false) // SteelSeries: 01 02 is a reset there
  assert.equal(isSparklinkDevice(dev(0x3151, 0x4015)), false) // RongYuan's VID, another protocol
})

test('connect reads the board: name, firmware, its own layout and legends, profiles, rates', async () => {
  const { transport } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  assert.equal(d.info.name, 'MG75 MAX')
  assert.equal(d.info.firmwareVersion, '1.2.3.4')
  assert.equal(d.layout.source, 'board')
  assert.equal(d.layout.keys.length, 15 + 15 + 14 + 14 + 10)
  const space = d.layout.keys.find(k => k.w === 6.25)
  assert.ok(space && space.y === 4)
  assert.equal(d.layout.keys[0].label, 'A')
  assert.equal(d.layout.keys[16].w, 1) // second key of row 1 after a 1.5u key
  assert.equal(d.layout.keys[16].x, 1.5)
  assert.equal(d.capabilities.profiles, 4)
  assert.deepEqual(d.capabilities.pollingRates, [8000, 4000, 1000, 125])
  assert.equal(d.capabilities.travelStepMm, 0.01)
  assert.equal(d.capabilities.travelMm, 3.8)
  assert.equal(d.capabilities.layers, 4)
})

test('boards without magnetic switches are turned away', async () => {
  const { transport } = fakeBoard({ magnetic: false })
  await assert.rejects(SparklinkDriver.connect(transport, usb), /without magnetic switches/)
})

test('keymap: rows of 21 codes, only changed rows written, then saved', async () => {
  const { transport, state, cfg } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  const map = await d.getKeymap(0, 0)
  assert.equal(map[0], 0x04)
  map[0] = ui.uiConsumer(0xe9) // volume up
  map[1] = ui.uiMouseButton(4) // back
  map[2] = ui.uiMomentaryLayer(2) // Fn2
  map[3] = 0x10000 // L Ctrl
  await d.setKeymap(0, 0, map)
  assert.deepEqual(state.writes, [['row', 0, 0]])
  assert.deepEqual(state.saves, [0x04])
  assert.deepEqual(cfg[0].keys[0][0].slice(0, 4), [0x20e9, 0x4500, 0xf102, 0xe0])
  assert.deepEqual(await d.getKeymap(0, 0), map)
  // board-specific codes survive unchanged and are named
  cfg[0].keys[0][1][0] = 0xf301
  const again = await d.getKeymap(0, 0)
  assert.equal(d.keycodeLabel(again[15]), 'Color')
  // transparent is its own code here; an empty slot does nothing
  assert.equal(d.transparentKeycode, (0x7f << 24) | 1)
  assert.equal(d.keycodeLabel(d.transparentKeycode), '▽')
  assert.ok(d.extraKeycodes().some(k => k.value === d.transparentKeycode && k.label === '▽ Transparent'))
  await d.setKeymap(0, 0, again)
  assert.equal(state.writes.length, 1)
  // Fn layer and another profile: the board switches profile first
  const fn = await d.getKeymap(2, 1)
  fn[5] = 0x3a
  await d.setKeymap(2, 1, fn)
  assert.deepEqual(state.writes.slice(1), [['profile', 2], ['row', 1, 0]])
  assert.equal(cfg[2].keys[1][0][5], 0x3a)
})

test('actuation: modes, one actuation point, untouched switch fields, save', async () => {
  const { transport, state, cfg } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  const act = await d.getActuation(0)
  assert.equal(act.length, 68)
  assert.deepEqual(act[0], {
    actuationMm: 1.5, rapidTrigger: false, splitSensitivity: false, rtPressMm: 0.15, rtReleaseMm: 0.15,
    continuous: false, deadzoneEnabled: false, topDeadzoneMm: 0, bottomDeadzoneMm: 0, releaseMm: 1.2
  })
  act[0] = { ...act[0], rapidTrigger: true, continuous: false, actuationMm: 0.4, splitSensitivity: true, rtPressMm: 0.1, rtReleaseMm: 0.2,
    deadzoneEnabled: true, topDeadzoneMm: 0.1, bottomDeadzoneMm: 0.3 }
  act[1] = { ...act[1], rapidTrigger: true, continuous: true }
  await d.setActuation(0, act)
  assert.deepEqual(state.writes, [['perf', 0, 0], ['perf', 0, 1]])
  assert.deepEqual(state.saves, [0x02])
  const k0 = cfg[0].perf.get('0:0')
  assert.equal(k0.mode, 2) // Rapid Trigger, continuous off
  assert.equal(k0.rtFirstTouch, 400); assert.equal(k0.normalPress, 1500) // the plain point stays
  assert.equal(k0.rtPress, 100); assert.equal(k0.rtRelease, 200)
  assert.equal(k0.pressDead, 100); assert.equal(k0.releaseDead, 300)
  assert.equal(k0.axisV2Id, 0x0102); assert.equal(k0.axisCoefficient, 77); assert.equal(k0.calibrate, 1)
  assert.equal(cfg[0].perf.get('0:1').mode, 1) // continuous
  const back = await d.getActuation(0)
  assert.deepEqual(back[0], { ...act[0], releaseMm: 1.2 })
  assert.equal(back[1].continuous, true)
  // nothing changed: nothing written
  await d.setActuation(0, back)
  assert.equal(state.writes.length, 2)
})

test('live travel is read a row at a time, in micrometres', async () => {
  const { transport, route } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  route.set(0, [0, 1250, 3800])
  const t = await d.readTravel()
  assert.equal(t.length, 68)
  assert.equal(t[1].raw, 1250)
  assert.ok(Math.abs(t[2].travelMm - 3.8) < 1e-9)
})

test('report rate and factory reset', async () => {
  const { transport, state } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  assert.deepEqual(await d.getOptions(), { pollingRateHz: 1000 })
  await d.setOptions({ pollingRateHz: 8000 })
  assert.equal(state.rate, 0)
  await assert.rejects(d.setOptions({ pollingRateHz: 2000 }), /not offered/)
  await d.factoryReset()
  assert.equal(state.resets, 1)
})

test('a board that reports no key positions gets a grid of its keys', () => {
  const styles = Array.from({ length: 8 }, () => Array.from({ length: 21 }, () => ({ row: 0, col: 0, ratio: 0 })))
  const base = Array.from({ length: 8 }, (_, r) => Array.from({ length: 21 }, (_, c) => (r < 2 && c < 3 ? 4 + c : 0)))
  const { layout, positions } = layoutFrom(styles, base)
  assert.equal(layout.source, 'grid')
  assert.equal(positions.length, 6)
  assert.deepEqual(positions[3], { row: 1, col: 0 })
})

test('replies are matched on group and sub-command; stray reports are skipped', async () => {
  const listeners = new Set()
  const device = {
    opened: true,
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    async close() {},
    async sendReport(_id, data) {
      const req = new Uint8Array(data)
      const emit = bytes => setTimeout(() => listeners.forEach(l => l({ reportId: 0, data: new DataView(Uint8Array.from(bytes).buffer) })), 0)
      emit([0x05, 0x01, 9, 9]) // something else the board pushes
      emit([req[0], req[1], 0x2a])
    }
  }
  const t = new InputReportTransport(device, 0)
  const r = await t.exchange(Uint8Array.from([0x02, 0x0c, 0]), 500, x => x[0] === 0x02 && x[1] === 0x0c)
  assert.equal(r[2], 0x2a)
})

test('advanced keys: SOCD pairs, tap-hold, toggle; vendor-only kinds left alone', async () => {
  const { transport, state, cfg } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  assert.deepEqual(d.capabilities.advancedKeys, ['nullBind', 'tapHold', 'toggle', 'macro'])
  // a DKS someone set in the vendor app on key (1,5)
  cfg[0].hk.set('1:5', [6, 2, 1, 5, 1, 0x14, 0, 0x1a, 0, 0, 0, 0, 0, 31, 31, 31, 31])
  assert.deepEqual(await d.getAdvancedKeys(0), [])
  // A = row 2 col 1, D = row 2 col 3 in the fake's layout (key indices 31 and 33)
  const keys = [
    { kind: 'nullBind', layer: 0, key: 31, secondaryKey: 33, behavior: 'primary', bottomOutMm: 0 },
    { kind: 'tapHold', layer: 0, key: 30, tap: 0x29, hold: 0x10000, tappingTermMs: 220, holdOnOtherKeyPress: false },
    { kind: 'toggle', layer: 0, key: 2, keycode: 0x1e, tappingTermMs: 300 }
  ]
  await d.setAdvancedKeys(0, keys)
  const rec = (r, c) => cfg[0].hk.get(`${r}:${c}`)
  // SOCD: both keys, each naming the other, own keycode first, mirrored rule
  const a = rec(2, 1), b = rec(2, 3)
  assert.equal(a[4], 6); assert.deepEqual([a[5], a[6]], [2, 3]); assert.equal(a[13], 1)
  assert.equal(b[4], 6); assert.deepEqual([b[5], b[6]], [2, 1]); assert.equal(b[13], 2)
  assert.equal(a[7] | (a[8] << 8), cfg[0].keys[0][2][1])
  // MT: tap first, hold second, time in ms
  const mt = rec(2, 0)
  assert.equal(mt[4], 3)
  assert.deepEqual([mt[5] | (mt[6] << 8), mt[7] | (mt[8] << 8), mt[9] | (mt[10] << 8)], [0x29, 0xe0, 220])
  const tgl = rec(0, 2)
  assert.deepEqual([tgl[4], tgl[5] | (tgl[6] << 8), tgl[7] | (tgl[8] << 8)], [4, 0x1e, 300])
  assert.ok(state.saves.includes(0x05))
  assert.ok(cfg[0].hk.has('1:5')) // the vendor's DKS survives
  // read back exactly what was written
  const back = await d.getAdvancedKeys(0)
  const byKind = k => back.find(x => x.kind === k)
  assert.deepEqual(byKind('nullBind'), keys[0])
  assert.deepEqual(byKind('tapHold'), keys[1])
  assert.deepEqual(byKind('toggle'), keys[2])
  // unchanged: nothing written; removing: cleared, the DKS still there
  const before = state.writes.length
  await d.setAdvancedKeys(0, back)
  assert.equal(state.writes.length, before)
  await d.setAdvancedKeys(0, [])
  assert.equal(cfg[0].hk.size, 1)
  assert.ok(cfg[0].hk.has('1:5'))
  await assert.rejects(d.setAdvancedKeys(0, [{ ...keys[0], behavior: 'distance' }]), /deeper press/)
  await assert.rejects(d.setAdvancedKeys(0, [{ ...keys[2], layer: 1 }]), /base layer/)
})

test('macros: 16 shared slots, played by M0..M15 keycodes on any layer', async () => {
  const { transport, state, cfg, macros } = fakeBoard()
  const d = await SparklinkDriver.connect(transport, usb)
  // slot 0 holds another profile's macro: not ours to overwrite
  macros[0].header = [1, 2, 0, 1, 0, 0]
  const steps = [
    { keycode: 0x10000, action: 'press', delayMs: 15 },
    { keycode: 0x06, action: 'tap', delayMs: 40 },
    { keycode: 0x10000, action: 'release', delayMs: 0 }
  ]
  const keys = [
    { kind: 'macro', layer: 0, key: 5, steps, mode: 'repeat', repeat: 3 },
    { kind: 'macro', layer: 1, key: 6, steps, mode: 'hold', repeat: 1 },
    { kind: 'tapHold', layer: 0, key: 30, tap: 0x29, hold: 0x10000, tappingTermMs: 200, holdOnOtherKeyPress: false }
  ]
  await d.setAdvancedKeys(0, keys)
  // the repeat-3 macro took slot 1 (slot 0 is protected), the held one slot 2
  assert.equal(cfg[0].keys[0][0][5], 0xf501)
  assert.equal(cfg[0].keys[1][0][6], 0xf502)
  assert.deepEqual(macros[1].header, [1, 4, 0, 3, 0, 0]) // valid, 4 actions, repeat 3, mode 0
  assert.deepEqual(macros[2].header, [1, 4, 0, 1, 0, 4]) // hold
  // action 2 is C pressed with no delay; bit 31 set, keycode 0x06
  const a = macros[1].actions
  assert.deepEqual(a.slice(4, 8), [0x06, 0x00, 0x00, 0x80])
  assert.deepEqual(a.slice(8, 12), [0x06, 0x00, 40, 0x00])
  assert.ok(state.saves.includes(0x06))
  assert.equal(macros[0].header[0], 1)

  const back = await d.getAdvancedKeys(0)
  const m = back.filter(k => k.kind === 'macro')
  assert.equal(m.length, 2)
  assert.equal(m[0].mode, 'repeat'); assert.equal(m[0].repeat, 3)
  assert.deepEqual(m[0].steps.map(s => s.action), ['press', 'press', 'release', 'release'])
  assert.equal(m[1].layer, 1); assert.equal(m[1].mode, 'hold')
  assert.ok(back.some(k => k.kind === 'tapHold'))
  // unchanged: nothing written
  const before = state.writes.length
  await d.setAdvancedKeys(0, back)
  assert.equal(state.writes.length, before)
  // removing the macros: base key back to its default, Fn key falls through
  await d.setAdvancedKeys(0, back.filter(k => k.kind !== 'macro'))
  assert.equal(cfg[0].keys[0][0][5], 0x09)
  assert.equal(cfg[0].keys[1][0][6], 0x0001)
  await assert.rejects(
    d.setAdvancedKeys(0, [{ ...keys[0], steps: Array(61).fill(steps[0]) }]),
    /at most 60/
  )
})
