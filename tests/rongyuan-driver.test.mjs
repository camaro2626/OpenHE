import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}

const { RongyuanDriver } = await bundle('src/drivers/rongyuan/driver.ts')
const { Wire } = await bundle('src/drivers/rongyuan/wire.ts')
const proto = await bundle('src/drivers/rongyuan/protocol.ts')
const extras = await bundle('src/drivers/rongyuan/extras.ts')
const ui = await bundle('src/drivers/keycodes.ts')

const devices = JSON.parse(readFileSync('src/drivers/rongyuan/data/devices.json'))
const layoutFile = name => JSON.parse(readFileSync(`src/drivers/rongyuan/data/layouts/${name}.json`))
const deps = {
  findSpec: async id => devices.find(d => d.id === id) ?? null,
  loadLayout: async name => { try { return layoutFile(name) } catch { return null } },
}

const checksumOk = buf => {
  // LEDPARAM and the edge light sum bytes 0..7 into byte 8
  const end = buf[0] === 0x07 || buf[0] === 0x08 ? 8 : 7
  let s = 0
  for (let i = 0; i < end; i++) s += buf[i]
  return buf[end] === 0xff - (s & 0xff)
}

/**
 * A gen2 board in software, following sharkfin's docs/PROTOCOL.md: 0x8F
 * identify with the revision at 7..8, 0x80 answering zeros by cable, keymap
 * pages on 0x8A/0x90, single-slot writes on 0x0A/0x10, switch columns on
 * 0xE5/0x65 (u16 travel columns, byte columns), 0x1B stream flag.
 */
function fakeGen2({ id, revision = 0x0309, layout, profiles = 4 }) {
  const wide = new Set([0, 1, 2, 3, 4, 6])
  const blank = () => new Uint8Array(512)
  const keymaps = Array.from({ length: profiles }, () => [blank(), blank(), blank(), blank()])
  const fn = Array.from({ length: profiles }, blank)
  // factory keymap from the layout's own entries, slot = matrixIndex or position
  layout.keys.forEach((k, i) => {
    const slot = k.matrixIndex ?? i + 1
    const e = k.matrixEntry ?? [0, 0, 4 + (i % 26), 0]
    for (const km of keymaps) km[0].set(e, slot * 4)
  })
  const defaults = { 0: 200, 1: 280, 2: 50, 3: 50, 4: 50, 5: 0, 6: 30, 7: 0, 9: 255, 252: 0 }
  const columns = Array.from({ length: profiles }, () => {
    const m = new Map()
    for (const [c, v] of Object.entries(defaults)) m.set(Number(c), new Array(128).fill(v))
    return m
  })
  const state = {
    profile: 0, stream: 0, commits: 0, writes: [], bad: 0,
    led: [3, 2, 4, 8, 0, 0, 0], side: [1, 2, 3, 7, 255, 0, 0], debounce: 5, autoOs: 0, resets: 0, sleep: [180, 0, 240, 0, 1800 & 0xff, 1800 >> 8, 2400 & 0xff, 2400 >> 8]
  }
  const macros = Array.from({ length: 50 }, () => new Uint8Array(256))
  const dks = Array.from({ length: profiles }, () => Array.from({ length: 4 }, () => new Uint8Array(128)))
  let reply = new Uint8Array(64)
  const colBytes = (p, col) => {
    const vals = columns[p].get(col)
    if (wide.has(col)) return Uint8Array.from(vals.flatMap(v => [v & 0xff, v >> 8]))
    return Uint8Array.from(vals)
  }
  const setColBytes = (p, col, offset, bytes) => {
    const vals = columns[p].get(col)
    bytes.forEach((b, i) => {
      const o = offset + i
      if (wide.has(col)) {
        const s = o >> 1
        if (s >= 128) return
        vals[s] = o & 1 ? (vals[s] & 0xff) | (b << 8) : (vals[s] & 0xff00) | b
      } else if (o < 128) vals[o] = b
    })
  }
  const handle = req => {
    if (!checksumOk(req)) { state.bad++; return }
    const out = new Uint8Array(64)
    const op = req[0]
    switch (op) {
      case 0x8f:
        out[0] = 0x8f; out.set([id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, id >>> 24], 1)
        out[7] = revision & 0xff; out[8] = revision >> 8
        break
      case 0x80: out[0] = 0x80; break
      case 0x84: out[0] = 0x84; out[1] = state.profile; break
      case 0x04: state.profile = req[1]; state.writes.push(['profile', req[1]]); out[0] = 0x04; break
      case 0x8a: out.set(keymaps[req[1]][req[4]].subarray(req[3] * 64, req[3] * 64 + 64)); break
      case 0x90: out.set(fn[req[2]].subarray(req[4] * 64, req[4] * 64 + 64)); break
      case 0x0a:
        keymaps[req[1]][req[6]].set(req.subarray(8, 12), req[2] * 4)
        state.writes.push(['key', req[1], req[2], [...req.subarray(8, 12)]])
        break
      case 0x10:
        fn[req[2]].set(req.subarray(8, 12), req[3] * 4)
        state.writes.push(['fn', req[2], req[3]])
        break
      case 0xe5:
        if (req[1] === 10) { const b = dks[state.profile][req[3] >> 1]; out.set(b.subarray((req[3] & 1) * 64, (req[3] & 1) * 64 + 64)); break }
        out.set(colBytes(state.profile, req[1]).subarray(req[3] * 64, req[3] * 64 + 64)); break
      case 0x65: {
        const [, col, bulk, at, last] = req
        if (col === 8) {
          assert.equal(bulk, 0, 'dks actions are written one slot at a time')
          for (let i = 0; i < 4; i++) dks[state.profile][i][at] = req[8 + i]
          state.writes.push(['col', col, bulk, at, last])
          if (last) state.commits++
          break
        }
        if (bulk) setColBytes(state.profile, col, at * 56, req.subarray(8, 8 + 56))
        else setColBytes(state.profile, col, at * (wide.has(col) ? 2 : 1), req.subarray(8, wide.has(col) ? 10 : 9))
        state.writes.push(['col', col, bulk, at, last])
        if (last) state.commits++
        break
      }
      case 0x1b: state.stream = req[1]; break
      case 0x0c: {
        // gen2 userpic: [0x0C, slot, 0xFF, page, len, last, 0, ck7] + data
        assert.equal(req[2], 0xff)
        state.userpic ??= new Array(378).fill(0)
        state.userpic.splice(req[3] * 56, req[4], ...req.subarray(8, 8 + req[4]))
        state.writes.push(['userpic', req[3], req[5]])
        break
      }
      case 0x07: state.led = [...req.subarray(1, 8)]; state.writes.push(['led']); break
      case 0x87: out[0] = 0x87; out.set(state.led, 1); break
      case 0x08: state.side = [...req.subarray(1, 8)]; state.writes.push(['side']); break
      case 0x88: out[0] = 0x88; out.set(state.side, 1); break
      case 0x06: state.debounce = req[1]; state.writes.push(['debounce', req[1]]); break
      case 0x86: out[0] = 0x86; out[1] = state.debounce; break
      case 0x11: state.sleep = [...req.subarray(8, 16)]; state.writes.push(['sleep']); break
      case 0x91: out[0] = 0x91; out.set(state.sleep, 8); break
      case 0x17: state.autoOs = req[1]; break
      case 0x97: out[0] = 0x97; out[1] = state.autoOs; break
      case 0x01: state.resets++; break
      case 0x0b: {
        const [, slot, page, len, last] = req
        assert.equal(len, 56)
        const start = page * 56
        macros[slot].set(req.subarray(8, 8 + Math.min(56, 256 - start)), start)
        state.writes.push(['macro', slot, page, last])
        break
      }
      case 0x8b: out.set(macros[req[1]].subarray(req[2] * 64, req[2] * 64 + 64)); break
      default: out[0] = op
    }
    reply = out
  }
  const node = {
    async sendFeature(buf) { assert.equal(buf.length, 64); handle(buf) },
    async receiveFeature() { return reply },
  }
  return { node, state, keymaps, fn, columns, macros, dks }
}

function fakeClock() {
  let t = 0
  return { slept: 0, now: () => t, async sleep(ms) { t += ms; this.slept += ms } }
}

const usb = { vendorId: 0x3151, productId: 0x5030, productName: 'RY' }

async function connect(opts) {
  const board = fakeGen2(opts)
  const clock = fakeClock()
  const wire = new Wire(board.node, clock)
  const driver = await RongyuanDriver.connect(wire, deps, usb)
  return { board, clock, driver }
}

test('checksums and column packets match sharkfin', () => {
  const g = proto.Columns.gen2(0x0309)
  const p = g.setOne(0, 5, true, 200)
  assert.deepEqual([...p.subarray(0, 5)], [0x65, 0, 0, 5, 1])
  assert.deepEqual([p[8], p[9]], [200, 0])
  assert.ok(checksumOk(p))
  assert.equal(g.setOne(0, 128, true, 1), null)
  const wide = g.setAll(0, new Array(128).fill(200), true)
  assert.equal(wide.length, 5)
  assert.ok(wide.slice(0, 4).every(x => x[4] === 0) && wide[4][4] === 1)
  assert.equal(g.setAll(7, new Array(128).fill(0x80), false).length, 3)
  assert.equal(proto.Columns.gen2(0x0507).unitMm, 0.005)
  assert.equal(proto.Columns.gen2(0x0200).unitMm, 0.1)
  // firmware clamps
  assert.equal(g.toWire(0, 0.05), 10)
  assert.equal(g.toWire(2, 0), 1)
  assert.equal(g.toWire(6, 9), 340)
  const y = proto.Columns.yc500()
  assert.equal(y.toMm(0, 18), 1.9)
  assert.equal(y.toMm(6, 33), 0.6)
  assert.equal(y.toWire(6, 0.6), 33)
  assert.equal(proto.parseTravelReport(5, Uint8Array.from([0x1b, 0x2a, 0x03, 7])).counts, 0x032a)
})

test('a registry board connects with its stored picture', async () => {
  const { driver } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  assert.equal(driver.family, 'gen2')
  assert.equal(driver.info.firmwareVersion, '3.09')
  assert.equal(driver.layout.source, 'registry')
  assert.equal(driver.layout.keys.length, 67)
  assert.equal(driver.needsLayoutConfirmation, false)
  assert.equal(driver.capabilities.writable.actuation, true)
  assert.equal(driver.capabilities.travelStepMm, 0.01)
  assert.ok(driver.layout.width > 14 && driver.layout.width < 17, `width ${driver.layout.width}`)
  assert.ok(driver.layout.height > 4.5 && driver.layout.height < 5.6, `height ${driver.layout.height}`)
})

test('keymap reads as UI keycodes and writes only changed slots', async () => {
  const file = layoutFile('Common68_ZAP68')
  const { driver, board } = await connect({ id: 2268, layout: file })
  const map = await driver.getKeymap(0, 0)
  const esc = file.keys.findIndex(k => k.matrixEntry?.join() === '0,0,41,0')
  assert.ok(esc >= 0)
  assert.equal(map[esc], 0x29)
  map[esc] = ui.uiConsumer(0xe9) // volume up
  await driver.setKeymap(0, 0, map)
  const keyWrites = board.state.writes.filter(w => w[0] === 'key')
  assert.equal(keyWrites.length, 1)
  assert.deepEqual(keyWrites[0][3], [3, 0, 0xe9, 0])
  assert.deepEqual(await driver.getKeymap(0, 0), map)
  // unknown entries round-trip untouched
  board.keymaps[0][0].set([9, 0, 2, 0], file.keys[3].matrixIndex * 4)
  const again = await driver.getKeymap(0, 0)
  assert.equal(again[3] >>> 24, 0x7f)
  await driver.setKeymap(0, 0, again)
  assert.equal(board.state.writes.filter(w => w[0] === 'key').length, 1)
  // Fn layer
  const fnMap = await driver.getKeymap(1, 1)
  fnMap[0] = 0x3a // F1
  await driver.setKeymap(1, 1, fnMap)
  assert.deepEqual(board.state.writes.at(-1), ['fn', 1, file.keys[0].matrixIndex])
})

test('actuation: per-key path for one key, bulk columns for many', async () => {
  const { driver, board, clock } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  const a = await driver.getActuation(0)
  assert.equal(a.length, 67)
  assert.ok(Math.abs(a[0].actuationMm - 2.0) < 1e-9)
  assert.equal(a[0].rapidTrigger, false)
  assert.ok(Math.abs(a[0].rtPressMm - 0.5) < 1e-9) // kept while RT is off
  assert.equal(a[0].splitSensitivity, false)
  assert.equal(a[0].deadzoneEnabled, true)
  assert.ok(Math.abs(a[0].bottomDeadzoneMm - 0.3) < 1e-9)
  assert.ok(Math.abs(a[0].releaseMm - 2.8) < 1e-9)

  a[5] = { ...a[5], actuationMm: 0.5, rapidTrigger: true, splitSensitivity: true, rtPressMm: 0.15, rtReleaseMm: 0.2 }
  await driver.setActuation(0, a)
  const slot5 = driver['slots'][5]
  const col = board.columns[0]
  assert.equal(col.get(0)[slot5], 50)
  assert.equal(col.get(2)[slot5], 15)
  assert.equal(col.get(3)[slot5], 20)
  assert.equal(col.get(7)[slot5], 0x80)
  assert.equal(board.state.writes.filter(w => w[0] === 'col').length, 6)
  assert.equal(board.state.commits, 1)

  const before = clock.slept
  const all = a.map(k => ({ ...k, actuationMm: 1.2 }))
  await driver.setActuation(0, all)
  assert.ok(clock.slept - before >= 10000, 'flash cooldown between batches')
  assert.equal(board.state.commits, 2)
  assert.ok(driver['slots'].every(s => col.get(0)[s] === 120))
  assert.equal(col.get(7)[slot5], 0x80, 'rapid trigger kept on the key that had it')
  const bulk = board.state.writes.filter(w => w[0] === 'col' && w[2] === 1)
  assert.equal(bulk.length, 5, 'only the travel column changed')
  assert.equal(board.state.bad, 0)
})

test('switch columns follow the active profile', async () => {
  const { driver, board } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  await driver.getActuation(2)
  assert.deepEqual(board.state.writes.filter(w => w[0] === 'profile'), [['profile', 2]])
  assert.equal(board.state.profile, 2)
})

test('a board whose picture names no slots is matched and must be confirmed', async () => {
  const file = layoutFile('Common68_K80X68')
  const { driver } = await connect({ id: 2255, layout: file })
  assert.equal(driver.layout.source, 'inferred')
  assert.ok(driver.matchRate > 0.9)
  assert.equal(driver.needsLayoutConfirmation, true)
  const map = await driver.getKeymap(0, 0)
  await assert.rejects(driver.setKeymap(0, 0, map), /Confirm/)
  driver.confirmLayout()
  await driver.setKeymap(0, 0, map)
})

test('a board with a cleared keymap falls back to a slot grid', async () => {
  const file = layoutFile('Common68_K80X68')
  const board = fakeGen2({ id: 2255, layout: file })
  for (const km of board.keymaps) km[0].fill(0)
  board.keymaps[0][0].set([0, 0, 4, 0], 10 * 4)
  const driver = await RongyuanDriver.connect(new Wire(board.node, fakeClock()), deps, usb)
  assert.equal(driver.layout.source, 'grid')
  assert.equal(driver.layout.keys.length, 1)
  assert.equal(driver.layout.keys[0].label, '10')
})

test('read-only lineages refuse switch writes', async () => {
  const other = devices.find(d => d.family === 'gen2' && !d.internalName.startsWith('ry5088_'))
  const { driver } = await connect({ id: other.id, layout: { keys: [] } })
  assert.equal(driver.capabilities.writable.actuation, false)
  const a = await driver.getActuation(0)
  await assert.rejects(driver.setActuation(0, a), /read but not written/)
})

test('unknown ids are reported, not guessed', async () => {
  const board = fakeGen2({ id: 99999999, layout: { keys: [] } })
  await assert.rejects(RongyuanDriver.connect(new Wire(board.node, fakeClock()), deps, usb), /not in the board list/)
})

test('keycode translation covers keys, combos, media, mouse and Fn', async () => {
  const k = await bundle('src/drivers/rongyuan/keycodes.ts')
  const n = new k.NativeEntries()
  const cases = [
    [[0, 0, 4, 0], 0x04],
    [[0, 0xe0, 6, 0], 0x10600],
    [[0, 0, 0xe0, 0], 0x10000],
    [[0, 0, 0xe6, 0], 0x400000],
    [[0, 0xe0, 0x29, 0xe1], 0x32900],
    [[3, 0, 0xe9, 0], ui.uiConsumer(0xe9)],
    [[3, 0, 0x8a, 1], ui.uiConsumer(0x18a)],
    [[1, 0, 240, 0], 0x01010100],
    [[10, 1, 0, 0], 0x0d000000],
    [[0, 0, 0, 0], 0],
  ]
  for (const [entry, value] of cases) {
    assert.equal(k.entryToUi(entry, n), value, entry.join())
    assert.deepEqual(k.uiToEntry(value, n), entry)
  }
  const macro = k.entryToUi([9, 0, 3, 0], n)
  assert.deepEqual(k.uiToEntry(macro, n), [9, 0, 3, 0])
})

test('switch selector writes the per-key switch model with listed codes only', async () => {
  const { driver, board } = await connect({ id: 2281, layout: layoutFile('Common81_AGK75B~k2') })
  const cat = driver.switchCatalog()
  assert.deepEqual(cat.map(c => c.id), ['code-4', 'code-5', 'code-6', 'unset'])
  const setup = await driver.getSwitchSetup()
  assert.ok(setup.keySwitch.every(id => id === 'unset')) // code 0: never set
  setup.keySwitch[0] = 'code-5'
  setup.keySwitch[1] = 'code-6'
  await driver.setSwitchSetup(setup)
  const col = board.columns[0].get(252)
  assert.equal(col[driver['slots'][0]], 5)
  assert.equal(col[driver['slots'][1]], 6)
  assert.equal(col[driver['slots'][2]], 0, 'unset keys keep their code')
  assert.equal(board.state.commits, 1)
  const back = await driver.getSwitchSetup()
  assert.equal(back.keySwitch[0], 'code-5')
  await assert.rejects(driver.setSwitchSetup({ keySwitch: back.keySwitch.map(() => 'code-9'), tuning: {} }), /not offered/)
})

test('boards without listed switch models offer no switch selector', async () => {
  const { driver } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  assert.deepEqual(driver.switchCatalog(), [])
})

test('lighting: the board\'s light table, flag order and speed direction', async () => {
  const { driver, board } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  const info = driver.lightingInfo()
  assert.ok(info.backlight.effects.length > 5)
  assert.ok(info.backlight.effects.every(e => e.label))
  assert.equal(info.side, undefined) // X65HE has no edge light
  assert.equal(info.canSwitchOff, false) // gen2: options not decoded
  assert.deepEqual(info.flagOrder, { swapped: true, fromRegistry: true })
  // registry says swapped: nibble 8 is the fixed colour, wire speed 2 on gen2 is host 2
  const state = await driver.getLighting()
  assert.equal(state.backlight.mode, 3)
  assert.equal(state.backlight.rainbow, false)
  assert.equal(state.backlight.speed, 2)
  await driver.setBacklight({ mode: 4, speed: 4, brightness: 3, option: 1, rainbow: true, color: 0xffffff })
  // fastest is wire 0 on gen2; swapped rainbow is nibble 7; white goes out as FA
  assert.deepEqual(board.state.led, [4, 0, 3, (1 << 4) | 7, 0xfa, 0xfa, 0xfa])
  driver.setLightFlagOrder(false)
  await driver.setBacklight({ mode: 1, speed: 0, brightness: 4, option: 0, rainbow: false, color: 0x000001 })
  // unswapped fixed is 7; near-black is floored to 8,8,8
  assert.deepEqual(board.state.led, [1, 4, 4, 7, 8, 8, 8])
  assert.equal(driver.lightingInfo().flagOrder.fromRegistry, false)
})

test('lighting packets match sharkfin', () => {
  const yc = extras.ledWire('yc500', false)
  const pkt = extras.ledPacket({ mode: 2, speed: 0, brightness: 4, option: 0, rainbow: false, color: [255, 0, 0] }, yc)
  // yc500 speed 0 (slowest) is wire 5; Bit8 checksum at byte 8
  assert.deepEqual([...pkt.subarray(0, 8)], [0x07, 2, 5, 4, 7, 255, 0, 0])
  let sum = 0
  for (let i = 0; i < 8; i++) sum += pkt[i]
  assert.equal(pkt[8], 0xff - (sum & 0xff))
  // a preset nibble on GET overrides the colour
  const back = extras.parseLed(Uint8Array.from([0x87, 1, 5, 4, 3, 1, 2, 3]), yc)
  assert.deepEqual(back.color, [0, 255, 0])
  assert.equal(back.speed, 0)
  // edge light: speed not inverted, neon forces rainbow
  const side = extras.sidePacket({ mode: 3, speed: 1, brightness: 2, option: 0, rainbow: false, color: [0, 0, 255] }, false)
  assert.deepEqual([...side.subarray(0, 5)], [0x08, 3, 1, 2, 8])
  // yc500 options: read-modify-write keeps keyboard-lock and mac bits
  const cur = Uint8Array.from([0x86, 0, 0b1000_0010, 5, 6])
  const o = extras.parseKbOptions(cur, 0x86)
  assert.equal(o.macMode, true)
  const out = extras.kbOptionsPacket({ ...o, winLock: true, backlightOff: true }, 0x06, cur)
  assert.deepEqual([...out.subarray(0, 5)], [0x06, 0, 0b1001_0011, 5, 6])
  // debounce: yc500 pads a zero, gen2 does not
  assert.deepEqual([...extras.debouncePacket(extras.familyOps('yc500'), 4).subarray(0, 3)], [0x11, 0, 4])
  assert.deepEqual([...extras.debouncePacket(extras.familyOps('gen2'), 4).subarray(0, 2)], [0x06, 4])
})

test('per-key colour packets match sharkfin (yc500 and gen2)', () => {
  const blob = new Uint8Array(384).map((_, i) => i & 0xff)
  const yc = extras.userpicPackets('yc500', blob)
  assert.equal(yc.length, 7)
  // [0x0C, 0, len lo, len hi, page, 0, 0, ck7] + 56 bytes at 8
  assert.deepEqual([...yc[3].subarray(0, 7)], [0x0c, 0, 384 & 0xff, 384 >> 8, 3, 0, 0])
  assert.deepEqual([...yc[3].subarray(8, 12)], [168, 169, 170, 171])
  let sum = 0
  for (let i = 0; i < 7; i++) sum += yc[3][i]
  assert.equal(yc[3][7], 0xff - (sum & 0xff))
  // the last yc500 page carries the remaining 48 bytes
  assert.deepEqual([...yc[6].subarray(8 + 47, 8 + 49)], [383 & 0xff, 0])
  const g2 = extras.userpicPackets('gen2', blob)
  assert.equal(g2.length, 7) // 378 bytes
  assert.deepEqual([...g2[0].subarray(0, 7)], [0x0c, 0, 0xff, 0, 56, 0, 0])
  assert.deepEqual([...g2[6].subarray(0, 7)], [0x0c, 0, 0xff, 6, 42, 1, 0])
  assert.equal(g2[6][8 + 41], 377 & 0xff)
})

test('per-key colours: matrix slots, written to flash, then the per-key effect', async () => {
  const { driver, board } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  assert.deepEqual(driver.lightingInfo().perKey, { mode: 13, readable: false, overlay: false })
  assert.equal(driver.getPerKeyColors, undefined)
  const n = driver.layout.keys.length
  const colors = new Array(n).fill(null)
  colors[0] = 0x112233
  colors[5] = 0xff0000
  board.state.led[2] = 2
  await driver.setPerKeyColors(colors, true)
  const slot = k => driver.slots[k]
  assert.deepEqual(board.state.userpic.slice(slot(0) * 3, slot(0) * 3 + 3), [0x11, 0x22, 0x33])
  assert.deepEqual(board.state.userpic.slice(slot(5) * 3, slot(5) * 3 + 3), [0xff, 0, 0])
  assert.equal(board.state.userpic.filter(b => b).length, 4)
  const pics = board.state.writes.filter(w => w[0] === 'userpic')
  assert.equal(pics.length, 7)
  assert.equal(pics.at(-1)[2], 1) // last page flagged
  // then the effect: mode 13, brightness kept
  assert.equal(board.state.led[0], 13)
  assert.equal(board.state.led[2], 2)
  // already on the effect: no second mode write
  const leds = board.state.writes.filter(w => w[0] === 'led').length
  await driver.setPerKeyColors(colors, true)
  assert.equal(board.state.writes.filter(w => w[0] === 'led').length, leds)
})

test('macro blobs round-trip with sharkfin\'s short and long forms', () => {
  const m = {
    repeat: 3,
    events: [
      { kind: 'key', usage: 0xe0, pressed: true, delayMs: 0 },
      { kind: 'key', usage: 0x06, pressed: true, delayMs: 20 },
      { kind: 'key', usage: 0x06, pressed: false, delayMs: 300 },
      { kind: 'mouse', button: 1, pressed: true, delayMs: 127 },
      { kind: 'move', dx: -5, dy: 7, delayMs: 8 }
    ]
  }
  const blob = extras.macroToBlob(m)
  assert.deepEqual([...blob.subarray(0, 8)], [3, 0, 0xe0, 0x80, 0, 0, 0x06, 0x80 | 20])
  assert.deepEqual(extras.macroFromBlob(blob), m)
  assert.equal(extras.macroPages(blob), 1)
  assert.throws(() => extras.macroToBlob({ repeat: 1, events: Array(130).fill(m.events[0]) }), /too long/)
})

test('macros: bound through the keymap, written to free slots, unbound back to factory', async () => {
  const file = layoutFile('Common68_ZAP68')
  const { driver, board } = await connect({ id: 2268, layout: file })
  assert.deepEqual(await driver.getAdvancedKeys(0), [])
  // profile 1 already uses slot 0; it must be left alone
  board.keymaps[1][0].set([9, 0, 0, 0], file.keys[5].matrixIndex * 4)
  board.macros[0].set([1, 0, 0x04, 0x85])
  const steps = [
    { keycode: 0x10000, action: 'press', delayMs: 10 },
    { keycode: 0x06, action: 'tap', delayMs: 30 },
    { keycode: 0x10000, action: 'release', delayMs: 0 }
  ]
  const keys = [
    { kind: 'macro', layer: 0, key: 3, steps, mode: 'repeat', repeat: 2 },
    { kind: 'macro', layer: 1, key: 4, steps, mode: 'hold', repeat: 1 }
  ]
  await driver.setAdvancedKeys(0, keys)
  const slot1 = [...board.keymaps[0][0].subarray(file.keys[3].matrixIndex * 4, file.keys[3].matrixIndex * 4 + 4)]
  assert.deepEqual(slot1, [9, 0, 1, 0]) // slot 1: slot 0 belongs to profile 1
  assert.equal(board.macros[0][2], 0x04) // untouched
  assert.equal(board.macros[1][0], 2) // repeat count
  // different repeat for the held one: its own slot
  const fnEntry = [...board.fn[0].subarray(file.keys[4].matrixIndex * 4, file.keys[4].matrixIndex * 4 + 4)]
  assert.deepEqual(fnEntry, [9, 2, 2, 0])
  const back = await driver.getAdvancedKeys(0)
  assert.equal(back.length, 2)
  assert.deepEqual(back[0].steps, [
    { keycode: 0x10000, action: 'press', delayMs: 10 },
    { keycode: 0x06, action: 'press', delayMs: 0 },
    { keycode: 0x06, action: 'release', delayMs: 30 },
    { keycode: 0x10000, action: 'release', delayMs: 0 }
  ])
  assert.equal(back[0].mode, 'repeat')
  assert.equal(back[1].mode, 'hold')
  // saving unchanged writes nothing
  const before = board.state.writes.length
  await driver.setAdvancedKeys(0, structuredClone(back))
  assert.equal(board.state.writes.length, before)
  // removing the base-layer one restores the key's factory entry
  await driver.setAdvancedKeys(0, [structuredClone(back[1])])
  const restored = [...board.keymaps[0][0].subarray(file.keys[3].matrixIndex * 4, file.keys[3].matrixIndex * 4 + 4)]
  assert.deepEqual(restored, file.keys[3].matrixEntry ?? restored)
  assert.notEqual(restored[0], 9)
})

test('board settings: debounce, auto OS and factory reset', async () => {
  const { driver, board } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  assert.deepEqual(await driver.getOptions(), { debounce: 5, autoOs: false })
  await driver.setOptions({ debounce: 3, autoOs: true })
  assert.equal(board.state.debounce, 3)
  assert.equal(board.state.autoOs, 1)
  await driver.factoryReset()
  assert.equal(board.state.resets, 1)
})

test('wireless sleep timers: read-modify-write of all four, at sharkfin\'s offsets', async () => {
  const id = devices.find(d => d.family === 'gen2' && d.sleep24 && d.sleepBT && d.keyLayout === 'Common68_ZAP68')?.id ?? 2268
  const spec = devices.find(d => d.id === id)
  const { driver, board } = await connect({ id, layout: layoutFile(spec.keyLayout) })
  const opts = await driver.getOptions()
  if (!spec.sleep24) { assert.equal(opts.sleep, undefined); return }
  assert.deepEqual(opts.sleep, { sleep24: 240, deep24: 2400, sleepBt: 180, deepBt: 1800 })
  await driver.setOptions({ sleep: { sleep24: 600 } })
  // order on the wire: BT, 2.4, deep BT, deep 2.4; the others kept
  assert.deepEqual(board.state.sleep, [180, 0, 600 & 0xff, 600 >> 8, 1800 & 0xff, 1800 >> 8, 2400 & 0xff, 2400 >> 8])
})

test('sleep packets: yc500 writes at 8 but answers at 1; gen2 is symmetric', () => {
  const yc = extras.familyOps('yc500'), g2 = extras.familyOps('gen2')
  const t = { sleepBt: 300, sleep24: 120, deepBt: 1200, deep24: 900 }
  const pkt = extras.sleepPacket(yc, t)
  assert.equal(pkt[0], 0x12)
  assert.deepEqual([...pkt.subarray(8, 16)], [44, 1, 120, 0, 176, 4, 132, 3])
  assert.equal(extras.sleepPacket(g2, t)[0], 0x11)
  const ycReply = new Uint8Array(64); ycReply[0] = 0x92; ycReply.set(pkt.subarray(8, 16), 1)
  assert.deepEqual(extras.parseSleep(ycReply, yc), t)
  const g2Reply = new Uint8Array(64); g2Reply[0] = 0x91; g2Reply.set(pkt.subarray(8, 16), 8)
  assert.deepEqual(extras.parseSleep(g2Reply, g2), t)
})

test('advanced keys: snap, dynamic keystroke, mod-tap and toggle as sharkfin writes them', async () => {
  const file = layoutFile('Common68_ZAP68')
  const { driver, board } = await connect({ id: 2268, layout: file })
  const caps = driver.capabilities
  assert.deepEqual(caps.advancedKeys, ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle', 'macro'])
  assert.deepEqual(caps.advancedKeyLimits.nullBindBehaviors, ['last'])
  const slot = i => file.keys[i].matrixIndex
  const sub = (i, k) => [...board.keymaps[0][i].subarray(slot(k) * 4, slot(k) * 4 + 4)]
  const keys = [
    { kind: 'nullBind', layer: 0, key: 31, secondaryKey: 33, behavior: 'last', bottomOutMm: 0 },
    {
      kind: 'dynamicKeystroke', layer: 0, key: 16, keycodes: [0x14, 0x1a, 0, 0],
      actions: [['press', 'hold', 'release', 'hold'], ['hold', 'tap', 'hold', 'hold'], ['hold', 'hold', 'hold', 'hold'], ['hold', 'hold', 'hold', 'hold']],
      bottomOutMm: 3, pressMm: 0.5
    },
    { kind: 'tapHold', layer: 0, key: 30, tap: 0x29, hold: 0x10000, tappingTermMs: 250, holdOnOtherKeyPress: false },
    { kind: 'toggle', layer: 0, key: 2, keycode: 0x1e, tappingTermMs: 300, repeating: true }
  ]
  await driver.setAdvancedKeys(0, keys)
  const col = (c, k) => board.columns[0].get(c)[slot(k)]
  // snap: both keys kind 7 carrying each other
  assert.equal(col(7, 31) & 0x7f, 7); assert.equal(col(7, 33) & 0x7f, 7)
  assert.equal(col(9, 31), slot(33)); assert.equal(col(9, 33), slot(31))
  // dks: kind 2, first point column 4, second point the travel column, actions one byte per sub-layer
  assert.equal(col(7, 16) & 0x7f, 2)
  assert.equal(col(4, 16), 50); assert.equal(col(0, 16), 300)
  assert.equal(board.dks[0][0][slot(16)], 0b1011) // press A, release at C: cells 3,2
  assert.equal(board.dks[0][1][slot(16)], 0b0100) // tap at B
  assert.deepEqual(sub(1, 16), [0, 0, 0x1a, 0])
  // mod-tap: hold on sub-layer 0, tap on 1, 10 ms units
  assert.equal(col(7, 30) & 0x7f, 3); assert.equal(col(5, 30), 25)
  assert.deepEqual(sub(0, 30), [0, 0, 0xe0, 0]); assert.deepEqual(sub(1, 30), [0, 0, 0x29, 0])
  // repeating toggle is kind 5
  assert.equal(col(7, 2) & 0x7f, 5); assert.deepEqual(sub(0, 2), [0, 0, 0x1e, 0])
  // only per-slot column writes, every key's batch closed with `last`
  assert.ok(board.state.writes.filter(w => w[0] === 'col').every(w => w[2] === 0))

  const back = await driver.getAdvancedKeys(0)
  const byKind = k => back.find(a => a.kind === k)
  assert.deepEqual(byKind('nullBind'), keys[0])
  assert.deepEqual(byKind('dynamicKeystroke').keycodes, keys[1].keycodes)
  assert.deepEqual(byKind('dynamicKeystroke').actions.slice(0, 2), keys[1].actions.slice(0, 2))
  assert.ok(Math.abs(byKind('dynamicKeystroke').pressMm - 0.5) < 1e-9)
  assert.deepEqual(byKind('tapHold'), keys[2])
  assert.deepEqual(byKind('toggle'), keys[3])

  // unchanged: nothing written
  const before = board.state.writes.length
  await driver.setAdvancedKeys(0, back)
  assert.equal(board.state.writes.length, before)

  // removing them: plain kind again, rapid trigger bit kept, replaced keycodes back to factory
  board.columns[0].get(7)[slot(30)] |= 0x80
  driver.columnsCache = null
  await driver.setAdvancedKeys(0, [])
  assert.equal(col(7, 30), 0x80)
  for (const k of [31, 33, 16, 2]) assert.equal(col(7, k) & 0x7f, 0)
  assert.deepEqual(sub(0, 30), file.keys[30].matrixEntry)
  assert.deepEqual(await driver.getAdvancedKeys(0), [])
})

test('advanced keys: rules the board cannot follow are refused', async () => {
  const { driver } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  await assert.rejects(driver.setAdvancedKeys(0, [{ kind: 'toggle', layer: 1, key: 2, keycode: 4, tappingTermMs: 300 }]), /base layer/)
  await assert.rejects(driver.setAdvancedKeys(0, [{ kind: 'nullBind', layer: 0, key: 31, secondaryKey: 33, behavior: 'neutral', bottomOutMm: 0 }]), /last key/)
})

test('dks action bytes match sharkfin encodeDks/decodeDks', async () => {
  const { dksToStages, stagesToDks } = await bundle('src/drivers/rongyuan/driver.ts')
  // sharkfin: hold A..C is 3,2,0,0; tap at B is 0,1,0,0; a run of 3s to the end releases at D
  assert.equal(stagesToDks(['press', 'hold', 'release', 'hold']), 0b1011)
  assert.equal(stagesToDks(['hold', 'tap', 'hold', 'hold']), 0b0100)
  assert.equal(stagesToDks(['press', 'hold', 'hold', 'hold']), 0b101111) // 3,3,2: released at D
  for (let b = 0; b < 256; b++) {
    const st = dksToStages(b)
    const again = stagesToDks(st)
    assert.deepEqual(dksToStages(again), st, `byte ${b}`)
  }
})
