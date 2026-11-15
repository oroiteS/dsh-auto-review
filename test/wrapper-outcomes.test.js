import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { reviewContext } from '../index.js'
import { createAuditLogger } from '../audit.js'

test('gate outcomes are preserved and written accurately', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-outcomes-'))
  assert.equal(path.dirname(directory), os.tmpdir())
  assert.ok(path.basename(directory).startsWith('review-outcomes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const audit = createAuditLogger({ directory })
  t.after(() => audit.close())
  const captured = []
  const ctx = { llm: {}, permissionPresets: { current: () => 'auto' }, on(_event, cb) { captured.push(cb) } }
  const wrapper = reviewContext(ctx, undefined, audit)
  const decisions = [
    { kind: 'allow' },
    { kind: 'deny', reason: 'fake synthetic reason' },
    { kind: 'ask', reason: 'fake synthetic reason' },
    { kind: 'cancel' },
    { kind: 'deny', reason: 'synthetic failure', info: { code: 'AUTO_REVIEW_FAILED' } },
  ]
  for (const decision of decisions) wrapper.on('tools/pre-execute', async () => decision)
  const exec = { agent: { session: {} }, name: 'read' }
  for (let i = 0; i < decisions.length; i++) {
    assert.deepEqual(await captured[i](exec, async () => ({ kind: 'allow' })), decisions[i])
  }
  assert.equal(await audit.close(), true)
  const files = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
  assert.equal(files.length, 1)
  const content = await readFile(path.join(directory, files[0]), 'utf8')
  const records = content.trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(record => record.outcome), ['allow', 'deny', 'ask', 'cancel', 'error'])
  assert.doesNotMatch(content, /fake synthetic reason|synthetic failure/)
})
