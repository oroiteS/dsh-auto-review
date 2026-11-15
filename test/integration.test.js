import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewContext } from '../index.js'

function makeContext() {
  let listener
  const ctx = {
    llm: {},
    permissionPresets: { current: () => 'auto' },
    on(name, callback) { listener = callback; return () => {} },
  }
  return { ctx, getListener: () => listener }
}

test('audit logs only the fixed decision and timing', async () => {
  const { ctx, getListener } = makeContext()
  const records = []
  const wrapped = reviewContext(ctx, undefined, { async log(item) { records.push(item); return true } })
  wrapped.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  const exec = { agent: { session: {} }, name: 'bash', arguments: { command: 'secret' } }
  assert.deepEqual(await getListener()(exec, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.equal(records[0].modelDecision, 'unknown')
  assert.equal(records[0].risk, 'unknown')
  assert.equal(records[0].modelStatus, 'unknown')
  assert.equal(records[0].gateOutcome, 'allow')
  assert.match(records[0].reviewId, /^[0-9a-f-]{36}$/)
  assert.equal(records[0].outcome, 'allow')
  assert.ok(!JSON.stringify(records).includes('secret'))
})

test('audit loss visibly blocks tool body', async () => {
  const { ctx, getListener } = makeContext()
  reviewContext(ctx, undefined, { async log() { return false } }).on('tools/pre-execute', async () => ({ kind: 'allow' }))
  const result = await getListener()({ agent: { session: {} }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'AUTO_REVIEW_AUDIT_FAILED')
  assert.match(result.reason, /audit log failed/)
})

test('upstream model failure is logged as an error without its text', async () => {
  const { ctx, getListener } = makeContext()
  const records = []
  reviewContext(ctx, undefined, { async log(record) { records.push(record); return true } })
    .on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'sensitive response', info: { code: 'AUTO_REVIEW_FAILED' } }))
  await getListener()({ agent: { session: {} }, name: 'read' }, async () => ({ kind: 'allow' }))
  assert.equal(records[0].outcome, 'error')
  assert.doesNotMatch(JSON.stringify(records), /sensitive/)
})

test('outer PTC transport bypasses audit just as upstream', async () => {
  const { ctx, getListener } = makeContext()
  let writes = 0
  reviewContext(ctx, undefined, { async log() { writes++; return true } }).on('tools/pre-execute', async () => ({ kind: 'allow' }))
  await getListener()({ agent: { session: {} }, name: 'run_code' }, async () => ({ kind: 'allow' }))
  assert.equal(writes, 0)
})
