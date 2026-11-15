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

function fixture({ output = '{"risk":"low","decision":"allow"}', policy = 'ask', preset = 'auto', downstream = { kind: 'allow' }, auditOk = true } = {}) {
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
    llm: { async *stream(options) { calls.streams.push(options); yield { type: 'text-delta', index: 0, text: output }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    permissionPresets: { current: () => preset, registerAuto: () => { calls.registrations++; return () => {} } },
    approval: { overrideOf: () => policy }, workingDirectory: { ensure: async () => '/isolated' },
    root: { fiber: { state: 0 } }, sessions: { list: () => [] },
    on(event, listener) { assert.equal(event, 'tools/pre-execute'); gate = listener; return () => {} },
    effect(generator) { for (const ignored of generator()) void ignored },
  }
  const audit = { async log(record) { calls.audit.push({ ...record }); return auditOk } }
  upstream.apply(reviewContext(ctx, async () => ({ provider: 'review', model: 'model', system: 'test policy' }), audit))
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

test('review deny preserves a downstream deny or ask', async () => {
  for (const kind of ['deny', 'ask']) {
    const downstream = { kind, reason: 'existing gate' }
    const f = fixture({ downstream, output: '{"risk":"medium","decision":"deny"}' })
    assert.deepEqual(await f.dispatch(), downstream); assert.equal(f.calls.body, 0); assert.equal(f.calls.audit[0].outcome, kind)
  }
})

test('invalid outputs fail closed and are logged as error under both approval policies', async () => {
  for (const policy of ['ask', 'never']) for (const output of [
    'not json', '{"risk":"high","decision":"allow"}', '{"risk":"low","decision":"deny"}',
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

test('non-auto preset bypasses review and audit', async () => {
  const f = fixture({ preset: 'default' }); assert.equal((await f.dispatch()).kind, 'allow')
  assert.equal(f.calls.streams.length, 0); assert.equal(f.calls.audit.length, 0); assert.equal(f.calls.next, 1)
})
