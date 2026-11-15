import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewContext } from '../index.js'

test('concurrent reviews keep model verdicts and gate outcomes separate', async () => {
  const records = []
  let gate
  const ctx = {
    permissionPresets: { current: () => 'auto' },
    approval: { overrideOf: () => 'ask' },
    llm: { async *stream(request) {
      await Promise.resolve()
      const text = request.model === 'first'
        ? '{"risk":"low","decision":"allow"}'
        : '{"risk":"high","decision":"deny","reason":"synthetic reason"}'
      yield { type: 'text-delta', index: 0, text }
      await Promise.resolve()
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    on(_name, fn) { gate = fn },
  }
  const wrapped = reviewContext(ctx, async () => ({ provider: '', model: '', system: 'test' }), { async log(record) { records.push({ ...record }); return true } })
  wrapped.on('tools/pre-execute', async exec => {
    for await (const unused of wrapped.llm.stream({ purpose: 'auto-review', provider: 'sample', model: exec.agent.model, messages: [] })) void unused
    return { kind: exec.agent.model === 'first' ? 'allow' : 'ask' }
  })
  const first = { agent: { session: { id: 'fake-session' }, model: 'first' }, callId: 'fake-1', name: 'read' }
  const second = { agent: { session: { id: 'fake-session' }, model: 'second' }, callId: 'fake-2', name: 'read', parent: Symbol('parent') }
  const result = await Promise.all([gate(first, () => {}), gate(second, () => {})])
  assert.deepEqual(result.map(x => x.kind), ['allow', 'ask'])
  const allow = records.find(x => x.modelDecision === 'allow')
  const deny = records.find(x => x.modelDecision === 'deny')
  assert.equal(allow.risk, 'low')
  assert.equal(allow.gateOutcome, 'allow')
  assert.equal(allow.callMode, 'native')
  assert.equal(deny.risk, 'high')
  assert.equal(deny.gateOutcome, 'ask')
  assert.equal(deny.callMode, 'ptc-inner')
  assert.equal(deny.reason, 'synthetic reason')
  assert.notEqual(allow.reviewId, deny.reviewId)
  assert.notEqual(allow.reviewerRoute, deny.reviewerRoute)
  assert.equal(allow.approvalPolicy, 'ask')
  assert.equal(allow.sessionRef, deny.sessionRef)
  assert.notEqual(allow.callRef, deny.callRef)
  assert.match(allow.sessionRef, /^[a-f0-9]{64}$/)
})

test('observation never changes the model chunks delivered upstream', async () => {
  let gate
  const chunks = [{ type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }, { type: 'finish', reason: { kind: 'stop' } }]
  const received = []
  const ctx = { permissionPresets: { current: () => 'auto' }, llm: { async *stream() { yield* chunks } }, on(_name, fn) { gate = fn } }
  const wrapped = reviewContext(ctx, async () => ({ provider: '', model: '', system: 'x' }), { async log() { return true } })
  wrapped.on('tools/pre-execute', async () => {
    for await (const chunk of wrapped.llm.stream({ purpose: 'auto-review', provider: 'p', model: 'm', messages: [] })) received.push(chunk)
    return { kind: 'allow' }
  })
  await gate({ agent: { session: {} }, name: 'read' }, () => {})
  assert.equal(received[0], chunks[0])
  assert.equal(received[1], chunks[1])
})
