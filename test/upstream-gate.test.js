// Run with the application's Electron executable, not a standalone Node binary.
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { reviewContext } from '../index.js'

const install = process.env.DSH_INSTALL_DIR
const available = Boolean(process.versions.electron && install)
const test = available ? nodeTest : nodeTest.skip
const upstream = available
  ? await import(pathToFileURL(createRequire(path.join(install, 'package.json')).resolve('@deepseek-ai/dsh-experimental-auto-review')).href)
  : undefined

function fixture({ output = '{"risk":"low","decision":"allow"}', policy = 'ask', preset = 'auto', downstream = { kind: 'allow' }, auditOk = true, reasoningEffort, streamFailure = false, chunks } = {}) {
  const calls = { streams: [], audit: [], next: 0, body: 0, registrations: 0 }
  const args = { command: 'not executed: dangerous action placeholder' }
  const toolCall = { type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify(args) }
  const events = [
    { seq: 0, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [toolCall] } } },
    { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: toolCall.arguments } },
  ]
  const session = { id: 'session', header: { origin: 'user' }, surface: { nodes: [1] }, snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'original', model: 'original-model' }, tools: [{ name: 'bash', description: 'stub only', parameters: { type: 'object' } }] }), isOwnSeq: () => true }
  const agent = { session }
  const exec = { agent, name: 'bash', arguments: args, callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal }
  let gate
  const ctx = {
    llm: { async *stream(options) {
      calls.streams.push(options)
      if (chunks) {
        yield* chunks
      } else if (streamFailure) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'unsupported effort' } } }
      } else {
        yield { type: 'text-delta', index: 0, text: output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } },
    permissionPresets: { current: () => preset, registerAuto: () => { calls.registrations++; return () => {} } },
    approval: { overrideOf: () => policy }, workingDirectory: { ensure: async () => '/isolated' },
    root: { fiber: { state: 0 } }, sessions: { list: () => [] },
    on(event, listener) { assert.equal(event, 'tools/pre-execute'); gate = listener; return () => {} },
    effect(generator) { for (const ignored of generator()) void ignored },
  }
  const audit = { async log(record) { calls.audit.push({ ...record }); return auditOk } }
  upstream.apply(reviewContext(ctx, async () => ({ provider: 'review', model: 'model', system: 'test policy', reasoningEffort }), audit))
  return { calls, exec, async run() { return gate(exec, async () => { calls.next++; return downstream }) },
    async dispatch() { const decision = await this.run(); if (decision.kind === 'allow') calls.body++; return decision } }
}

test('upstream allow delegates and audit classifies the resulting allow', async () => {
  const f = fixture(); assert.deepEqual(await f.dispatch(), { kind: 'allow' })
  assert.equal(f.calls.body, 1); assert.equal(f.calls.next, 1); assert.equal(f.calls.registrations, 1)
  assert.equal(f.calls.audit[0].outcome, 'allow')
  const request = f.calls.streams[0]
  assert.equal(request.purpose, 'auto-review'); assert.equal(request.provider, 'review'); assert.equal(request.model, 'model'); assert.equal(request.system, 'test policy')
  assert.match(JSON.stringify(request.messages), /not executed: dangerous action placeholder/)
})

test('review deny never turns downstream allow into allow: ask and never', async () => {
  for (const policy of ['ask', 'never']) {
    const f = fixture({ policy, output: '{"risk":"high","decision":"deny","reason":"unsafe"}' })
    const result = await f.dispatch()
    assert.equal(result.kind, policy === 'never' ? 'deny' : 'ask')
    assert.equal(f.calls.next, policy === 'never' ? 0 : 1); assert.equal(f.calls.body, 0)
    assert.equal(f.calls.audit[0].outcome, result.kind)
    assert.equal(f.calls.audit[0].modelDecision, 'deny')
    assert.equal(f.calls.audit[0].risk, 'high')
    assert.equal(f.calls.audit[0].modelStatus, 'success')
    assert.equal(f.calls.audit[0].reason, 'unsafe')
    if (policy === 'never') assert.equal(result.info.code, 'AUTO_REVIEW_DENIED')
    else assert.match(result.reason, /unsafe/)
  }
})

test('approval reports when the review model supplies no reason', async () => {
  const f = fixture({ output: '{"risk":"high","decision":"deny"}' })
  const result = await f.dispatch()
  assert.equal(result.kind, 'ask')
  assert.match(result.displayReason.zh, /未提供具体原因/)
  assert.match(result.displayReason.en, /without providing a reason/)
  assert.equal(f.calls.body, 0)
})

test('downstream localized approval and reviewer reason are both preserved', async () => {
  const downstream = { kind: 'ask', reason: 'gate reason', displayReason: { en: 'Gate approval', zh: '其他权限审批' } }
  const f = fixture({ downstream, output: '{"risk":"high","decision":"deny","reason":"review reason"}' })
  const result = await f.dispatch()
  assert.equal(result.reason, 'gate reason')
  assert.match(result.displayReason.zh, /其他权限审批/)
  assert.match(result.displayReason.zh, /review reason/)
  assert.match(result.displayReason.en, /Gate approval/)
  assert.match(result.displayReason.en, /review reason/)
  assert.equal(f.calls.body, 0)
})

test('extended denials retain original risk and use the upstream approval flow', async () => {
  for (const risk of ['unknown', 'low']) for (const policy of ['ask', 'never']) {
    const output = JSON.stringify({ risk, decision: 'deny', reason: 'Insufficient authorization or evidence.' })
    const f = fixture({ policy, output })
    const result = await f.dispatch()
    assert.equal(result.kind, policy === 'ask' ? 'ask' : 'deny')
    assert.equal(f.calls.next, policy === 'ask' ? 1 : 0)
    assert.equal(f.calls.body, 0)
    assert.equal(f.calls.audit[0].risk, risk)
    assert.equal(f.calls.audit[0].modelDecision, 'deny')
    assert.equal(f.calls.audit[0].modelStatus, 'success')
    assert.equal(f.calls.audit[0].reason, 'Insufficient authorization or evidence.')
    if (policy === 'never') assert.equal(result.info.code, 'AUTO_REVIEW_DENIED')
    else assert.match(result.reason, /Insufficient authorization or evidence/)
  }
})

test('extended denial supports fragmented text, reasoning and block-end overwrite', async () => {
  const valid = '{"risk":"unknown","decision":"deny","reason":"未明确范围"}'
  const chunks = [
    { type: 'reasoning-delta', index: 4, text: 'internal' },
    { type: 'text-delta', index: 9, text: valid.slice(0, 20) },
    { type: 'text-delta', index: 9, text: valid.slice(20) },
    { type: 'block-end', index: 9, block: { type: 'text', text: valid } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const f = fixture({ chunks })
  assert.equal((await f.dispatch()).kind, 'ask')
  assert.equal(f.calls.audit[0].risk, 'unknown')
  assert.equal(f.calls.audit[0].reason, '未明确范围')
})

test('block-end replacement does not double-count a valid extended denial', async () => {
  const text = JSON.stringify({ risk: 'unknown', decision: 'deny', reason: 'x'.repeat(5000) })
  const chunks = [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const f = fixture({ chunks })
  assert.equal((await f.dispatch()).kind, 'ask')
  assert.equal(f.calls.audit[0].risk, 'unknown')
})

test('extended denial handles surrogate pairs split across deltas', async () => {
  const text = JSON.stringify({ risk: 'unknown', decision: 'deny', reason: '😀'.repeat(1500) })
  const chunks = [
    ...text.split('').map(part => ({ type: 'text-delta', index: 0, text: part })),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const f = fixture({ chunks })
  assert.equal((await f.dispatch()).kind, 'ask')
  assert.equal(f.calls.audit[0].risk, 'unknown')
})

test('extended denials fail closed on incomplete, invalid or oversized streams', async () => {
  const valid = { type: 'text-delta', index: 0, text: '{"risk":"unknown","decision":"deny","reason":"unclear"}' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  for (const chunks of [
    [valid],
    [valid, { type: 'finish', reason: { kind: 'max-tokens' } }],
    [valid, stop, { type: 'usage', usage: {} }],
    [valid, { type: 'text-delta', index: 1, text: '{}' }, stop],
    [{ type: 'reasoning-delta', index: 0, text: 'x'.repeat(1024 * 1024 + 1) }, valid, stop],
    [...Array.from({ length: 8192 }, () => ({ type: 'usage', usage: {} })), valid, stop],
  ]) {
    const f = fixture({ chunks })
    const result = await f.dispatch()
    assert.equal(result.kind, 'deny')
    assert.equal(result.info.code, 'AUTO_REVIEW_FAILED')
    assert.equal(f.calls.next, 0)
    assert.equal(f.calls.body, 0)
    assert.equal(f.calls.audit[0].outcome, 'error')
  }
})

test('cancelled review does not become a valid extended denial', async () => {
  const controller = new AbortController()
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', index: 0, text: '{"risk":"unknown","decision":"deny","reason":"unclear"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      controller.abort(new Error('cancelled'))
    },
  }
  const f = fixture({ chunks })
  f.exec.signal = controller.signal
  const result = await f.dispatch()
  assert.notEqual(result.kind, 'allow')
  assert.equal(f.calls.body, 0)
  assert.equal(f.calls.next, 0)
})

test('extended denials preserve downstream gates', async () => {
  for (const kind of ['deny', 'ask']) {
    const downstream = { kind, reason: 'existing gate' }
    const f = fixture({ downstream, output: '{"risk":"unknown","decision":"deny","reason":"Missing evidence"}' })
    const result = await f.dispatch()
    assert.equal(result.kind, kind)
    assert.equal(result.reason, downstream.reason)
    if (kind === 'ask') {
      assert.match(result.displayReason.zh, /existing gate/)
      assert.match(result.displayReason.zh, /Missing evidence/)
    } else assert.deepEqual(result, downstream)
    assert.equal(f.calls.body, 0)
    assert.equal(f.calls.audit[0].risk, 'unknown')
  }
})

test('review deny preserves a downstream deny or ask', async () => {
  for (const kind of ['deny', 'ask']) {
    const downstream = { kind, reason: 'existing gate' }
    const f = fixture({ downstream, output: '{"risk":"medium","decision":"deny"}' })
    const result = await f.dispatch()
    assert.equal(result.kind, kind); assert.equal(result.reason, downstream.reason)
    if (kind === 'ask') assert.match(result.displayReason.zh, /未提供具体原因/)
    else assert.deepEqual(result, downstream)
    assert.equal(f.calls.body, 0); assert.equal(f.calls.audit[0].outcome, kind)
  }
})

test('invalid outputs fail closed and are logged as error under both approval policies', async () => {
  for (const policy of ['ask', 'never']) for (const output of [
    'not json', '{"risk":"high","decision":"allow"}', '{"risk":"low","decision":"deny"}',
    '{"risk":"unknown","decision":"deny"}', '{"risk":"unknown","decision":"deny","reason":"  "}',
    '{"risk":"unknown","decision":"allow"}', '{"risk":"unknown","decision":"deny","reason":"x","extra":true}',
    '{"risk":"unknown","risk":"unknown","decision":"deny","reason":"x"}',
    '{"risk":"low","decision":"allow","reason":"extra"}', '{"risk":"low","risk":"high","decision":"allow"}',
  ]) {
    const f = fixture({ output, policy }); const result = await f.dispatch()
    assert.equal(result.kind, 'deny'); assert.equal(result.info.code, 'AUTO_REVIEW_FAILED')
    assert.equal(f.calls.next, 0); assert.equal(f.calls.body, 0); assert.equal(f.calls.audit[0].outcome, 'error')
  }
})

test('audit failure fails closed even when reviewer allows', async () => {
  const f = fixture({ auditOk: false }); const result = await f.dispatch()
  assert.equal(result.kind, 'deny'); assert.equal(result.info.code, 'AUTO_REVIEW_AUDIT_FAILED'); assert.equal(f.calls.body, 0)
})

test('unsupported reviewer effort fails closed through the upstream gate', async () => {
  const f = fixture({ reasoningEffort: 'unsupported', streamFailure: true })
  const result = await f.dispatch()
  assert.equal(f.calls.streams[0].reasoningEffort, 'unsupported')
  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'AUTO_REVIEW_FAILED')
  assert.equal(f.calls.next, 0)
  assert.equal(f.calls.body, 0)
  assert.equal(f.calls.audit[0].outcome, 'error')
})

test('non-auto preset bypasses review and audit', async () => {
  const f = fixture({ preset: 'default' }); assert.equal((await f.dispatch()).kind, 'allow')
  assert.equal(f.calls.streams.length, 0); assert.equal(f.calls.audit.length, 0); assert.equal(f.calls.next, 1)
})
