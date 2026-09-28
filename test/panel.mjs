/**
 * Panel component tests with a fake host: a tiny React shim (useState slots +
 * immediate useEffect) and a stub ui kit, so the component's logic — initial
 * load, Enter-toggle, `d` removal, install input — runs without the TUI.
 *
 * Run: node test/panel.mjs
 */

import assert from 'node:assert/strict'
import { panelComponent } from '../lib/index.js'

// ── fake manager: a mutable inventory + recorded calls ────────────────────

function fakeManager() {
  const calls = []
  const rows = [
    { name: 'dsh-tui-find', version: '0.4.4', enabled: true, installed: true, optional: false, removable: true, rows: [{ rowId: 'r1', moduleName: 'x' }], overrides: [] },
    { name: 'dsh-tui-theme', version: '0.7.2', enabled: false, installed: true, optional: false, removable: true, rows: [{ rowId: 'r2', moduleName: 'x' }], overrides: [] },
    { name: '@deepseek-ai/dsh-web-app', version: '0.1.7-rc.2', enabled: false, installed: false, optional: false, removable: false, rows: [], overrides: [] },
  ]
  const change = (target, enabled) => ({ changed: true, application: enabled === undefined ? 'restart-required' : 'applied', stage: 'x', target, enabled })
  return {
    calls,
    async listBundles() {
      calls.push(['listBundles'])
      return rows.map((row) => ({ ...row }))
    },
    async setBundleEnabled(name, enabled) {
      calls.push(['setBundleEnabled', name, enabled])
      const row = rows.find((r) => r.name === name)
      if (row !== undefined) row.enabled = enabled
      return change(name, enabled)
    },
    async removeBundle(name) {
      calls.push(['removeBundle', name])
      const index = rows.findIndex((r) => r.name === name)
      if (index >= 0) rows.splice(index, 1)
      return change(name)
    },
    async installBundle(spec) {
      calls.push(['installBundle', spec])
      const name = spec.split('@')[0]
      rows.push({ name, version: '1.0.0', enabled: true, installed: true, optional: false, removable: true, rows: [{ rowId: name, moduleName: name }], overrides: [] })
      return change(name)
    },
  }
}

// ── fake React / ui / channel ─────────────────────────────────────────────

function mount(manager) {
  const renders = []
  let component
  let inputHandler
  const pushed = []
  const slots = []
  let slotIndex = 0
  const ranEffects = new Set()
  const effectSlot = new Set()
  let effectIndex = 0

  const React = {
    useState(initial) {
      const slot = slotIndex++
      if (slots[slot] === undefined) slots[slot] = initial
      const setter = (value) => {
        slots[slot] = typeof value === 'function' ? value(slots[slot]) : value
        renders.push(() => draw())
      }
      return [slots[slot], setter]
    },
    useEffect(effect) {
      // All effects in this component declare [] deps: run each effect slot once.
      const slot = effectIndex++
      if (ranEffects.has(slot)) return
      ranEffects.add(slot)
      void effect()
    },
  }
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  React.createElement = createElement
  const ui = {
    Box: (props, ...children) => createElement('Box', props, ...children),
    Text: (props, ...children) => createElement('Text', props, ...children),
    useInput(handler) {
      inputHandler = handler
    },
  }
  const channel = {
    pushLocal: (title, lines) => pushed.push([title, lines]),
    notify() {},
  }
  function draw() {
    slotIndex = 0
    effectIndex = 0
    return component({ React, ui, channel, close() {} })
  }
  return {
    mount(fn) {
      component = fn
      draw()
    },
    async settle(label = '?') {
      // The mount-time effect suspends on the first await; flush microtasks so
      // its setBundles render lands in the queue before anything fires keys.
      await Promise.resolve()
      await Promise.resolve()
      for (let guard = 0; guard < 50 && renders.length > 0; guard += 1) {
        const batch = renders.splice(0)
        for (const run of batch) run()
        await Promise.resolve()
      }
      if (renders.length > 0) console.error(`settle[${label}] leaves ${renders.length} renders pending after 50 rounds`)
      assert.equal(renders.length, 0, `render queue must drain (${label})`)
    },
    fire(input, key = {}) {
      if (inputHandler === undefined) console.error('fire: no input handler registered yet')
      inputHandler?.(input, { return: false, escape: false, upArrow: false, downArrow: false, backspace: false, ...key })
    },
    key(over = {}) {
      return { return: false, escape: false, upArrow: false, downArrow: false, backspace: false, ...over }
    },
    calls: manager.calls,
    pushed,
  }
}

// ── the scenarios ─────────────────────────────────────────────────────────

// 1. Initial load: the effect reads the inventory once.
{
  const m = fakeManager()
  const h = mount(m)
  h.mount(panelComponent(undefined, () => m))
  await h.settle()
  assert.ok(m.calls.filter((call) => call[0] === 'listBundles').length >= 1, 'initial load calls listBundles')
}

// 2. Enter toggles the selected (first) row, and the list refreshes.
{
  const m = fakeManager()
  const h = mount(m)
  h.mount(panelComponent(undefined, () => m))
  await h.settle()
  const readsBefore = m.calls.filter((call) => call[0] === 'listBundles').length
  h.fire('', h.key({ return: true }))
  await h.settle()
  const toggle = m.calls.find((call) => call[0] === 'setBundleEnabled')
  assert.ok(toggle !== undefined, 'Enter calls setBundleEnabled')
  assert.deepEqual(toggle.slice(1), ['dsh-tui-find', false], 'the enabled row is toggled off')
  assert.ok(m.calls.filter((call) => call[0] === 'listBundles').length > readsBefore, 'the list refreshes after a toggle')
  assert.ok(h.pushed.some(([, lines]) => lines.some((line) => /✓ 停用/u.test(line))), 'the result line is pushed to the transcript')
}

// 3. `d` removes the selected row; the inventory refreshes and shrinks.
{
  const m = fakeManager()
  const h = mount(m)
  h.mount(panelComponent(undefined, () => m))
  await h.settle()
  h.fire('d', h.key())
  await h.settle()
  assert.deepEqual(m.calls.find((call) => call[0] === 'removeBundle')?.slice(1), ['dsh-tui-find'])
  assert.ok(h.pushed.some(([, lines]) => lines.some((line) => /✓ 卸载/u.test(line))))
  const after = await m.listBundles()
  assert.equal(after.some((row) => row.name === 'dsh-tui-find'), false, 'the inventory itself shrinks')
}

// 4. The install input: `i`, typing, Enter installs; the draft is consumed.
{
  const m = fakeManager()
  const h = mount(m)
  h.mount(panelComponent(undefined, () => m))
  await h.settle()
  h.fire('i', h.key())
  await h.settle()
  h.fire('dsh-open-path@0.6.2', h.key())
  await h.settle()
  h.fire('', h.key({ return: true }))
  await h.settle()
  assert.deepEqual(m.calls.find((call) => call[0] === 'installBundle')?.slice(1), ['dsh-open-path@0.6.2'])
  assert.ok(h.pushed.some(([, lines]) => lines.some((line) => /✓ 安装/u.test(line))))
}

console.log('✓ panel ok — 4 scenarios')
