import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

// Exercise the exact pure selector and serializer shipped in the browser entry,
// without claiming that a simulated DOM verifies the real approval card.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function approvalCall(')
const end = source.indexOf('    function ApprovalDetail(', start)
assert.ok(start >= 0 && end > start, 'approval-detail helpers must exist')
const { approvalCall, approvalRaw, approvalJson } = runInNewContext(`${source.slice(start, end)}\n({ approvalCall, approvalRaw, approvalJson })`)

function started(callId, name, args, subCalls = []) {
  return { phase: 'start', callId, name, argsRaw: JSON.stringify(args), subCalls }
}
function snapshot(...roots) {
  return { nodes: new Map(roots.map((root, index) => [index, { kind: 'tool-call', data: { root } }])) }
}

test('approval detail registers ahead of the built-in single-slot priority', () => {
  let entry
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { entry = value } } } })
  const plugin = entry.factory(() => ({}))
  const registrations = []
  const ctx = {
    effect(fn) { fn() },
    locale: { addLanguage() {}, register() {}, bind() { return () => '' } },
    remote: { session: {} },
    slots: {
      inject(_name, callback) { callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  const detail = registrations.filter(item => item.options.name === 'conversation.approval.detail')
  assert.equal(detail.length, 1)
  assert.ok(detail[0].options.priority < 0, 'built-in priority is 0 and lower values take precedence')
  assert.equal(detail[0].component.name, 'ApprovalDetail')
})

test('finds the exact pending native and nested PTC call', () => {
  const child = started('root:ptc:2', 'bash', { command: 'printf one\nprintf two', workdir: '/tmp' })
  const root = started('root', 'run_code', { code: 'not the reviewed child' }, [
    started('root:ptc:1', 'bash', { command: 'wrong command' }), child,
  ])
  assert.equal(approvalCall(snapshot(root), 'root'), root)
  assert.equal(approvalCall(snapshot(root), 'root:ptc:2'), child)
  assert.equal(approvalCall(snapshot(root), 'missing'), undefined)
})

test('does not guess when identity is ambiguous or not started', () => {
  const first = started('same', 'bash', { command: 'first' })
  const second = started('same', 'bash', { command: 'second' })
  assert.equal(approvalCall(snapshot(first, second), 'same'), undefined)
  assert.equal(approvalCall(snapshot({ ...first, phase: 'preparing' }), 'same'), undefined)
  assert.equal(approvalCall(snapshot({ ...first, kind: 'tool-result' }), 'same'), undefined)
})

test('raw logged arguments preserve duplicate keys and numeric spelling', () => {
  const raw = '{"n":9007199254740993,"n":1e400,"command":"safe"}'
  assert.equal(approvalRaw(raw), raw)
  assert.equal(approvalRaw('a\u202eb'), 'a\\u202eb')
})

test('JSON display preserves complete values and exposes direction controls', () => {
  const value = { command: 'printf "a b"\nsecond\u202erm -rf', workdir: '/tmp/a b', extra: 'x'.repeat(20000) }
  const rendered = approvalJson(value)
  assert.deepEqual(JSON.parse(rendered), value)
  assert.ok(rendered.includes('\\u202e'))
  assert.ok(rendered.includes('\\nsecond'))
  assert.ok(rendered.includes('x'.repeat(20000)))
})
