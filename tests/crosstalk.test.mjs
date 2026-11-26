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

const { capture, mergeTable, MAX_K } = await bundle('src/driverApp/crosstalk.ts')

const base = [1500, 1500, 1500, 1500]

test('a steady single press gives each neighbour its share of the press', () => {
  // key 1 pressed 800 counts; key 0 moved 8 (1 %), key 2 moved 2 (too little), key 3 nothing
  const r = capture(base, [1508, 2300, 1502, 1500], 1)
  assert.equal(r.ok, true)
  assert.equal(r.press, 800)
  assert.deepEqual(r.pairs, [{ victim: 0, aggressor: 1, k: 0.01 }])
})

test('readings that fall as a key goes down work the same', () => {
  const r = capture(base, [1492, 700, 1500, 1500], 1)
  assert.equal(r.ok, true)
  assert.deepEqual(r.pairs, [{ victim: 0, aggressor: 1, k: 0.01 }])
})

test('a press that is too shallow, a second key, or a brushed neighbour is refused', () => {
  assert.deepEqual(capture(base, [1500, 1650, 1500, 1500], 1), { ok: false, reason: 'not-held' })
  assert.deepEqual(capture(base, [1500, 2300, 1900, 1500], 1), { ok: false, reason: 'other-key', key: 2 })
  // 5 % of the press: more than magnetism, a finger on it
  assert.ok(0.05 > MAX_K)
  assert.deepEqual(capture(base, [1540, 2300, 1500, 1500], 1), { ok: false, reason: 'too-strong', key: 0 })
})

test('saving keeps the stored pairs of keys not measured, strongest first when full', () => {
  const stored = [{ victim: 0, aggressor: 1, k: 0.02 }, { victim: 2, aggressor: 3, k: 0.01 }]
  const measured = [{ victim: 0, aggressor: 1, k: 0.011 }]
  assert.deepEqual(mergeTable(stored, measured, new Set([1]), 96), [
    { victim: 2, aggressor: 3, k: 0.01 },
    { victim: 0, aggressor: 1, k: 0.011 }
  ])
  assert.deepEqual(mergeTable(stored, measured, new Set([1]), 1), [{ victim: 0, aggressor: 1, k: 0.011 }])
})
