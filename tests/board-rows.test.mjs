import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path, logLevel: 'silent' })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}

const { rowsFromLayout } = await bundle('src/driverApp/boardModel.ts')
const { layoutFromRegistry } = await bundle('src/drivers/rongyuan/layout.ts')

/** Left edge of every key in units, summing keys and gap slots the way the preview lays them out. */
function lefts(rows) {
  const at = new Map()
  for (const row of rows) {
    let x = 0
    for (const k of row) {
      if (!k.spacer) at.set(k.id, x)
      x += k.width ?? 1
    }
  }
  return at
}

test('gap slots keep their width: the RT80 right column lines up (Home, PgUp, PgDn, End)', () => {
  const file = JSON.parse(readFileSync('src/drivers/rongyuan/data/layouts/Common80_rt80~k2.json'))
  const { layout } = layoutFromRegistry(file)
  const { rows } = rowsFromLayout(layout)
  const at = lefts(rows)
  const x = text => {
    const k = layout.keys.find(k => k.label === text)
    return at.get(`k${k.index}`)
  }
  const col = ['Home', 'PgUp', 'PgDn', 'End'].map(x)
  for (const v of col) assert.ok(Math.abs(v - col[0]) < 0.15, `${col}`)
  // gap slots are real widths, not one-unit placeholders
  assert.ok(rows.flat().some(k => k.spacer && k.width < 1))
})
