#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStatusSnapshot } from './status.mjs'
import { buildGuardReport } from './index.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function main() {
  const root = process.cwd()
  const manifest = JSON.parse(readFileSync(join(root, 'project-kernel.json'), 'utf8'))
  assert(manifest.schemaVersion === 1, 'project-kernel schemaVersion must be 1')
  assert(manifest.kind === 'ai-project-kernel', 'project-kernel kind is invalid')
  assert(manifest.capabilities?.structuredStatus === true, 'structuredStatus capability missing')
  assert(manifest.capabilities?.structuredGuard === true, 'structuredGuard capability missing')

  const status = buildStatusSnapshot(root)
  const roundTrippedStatus = JSON.parse(JSON.stringify(status))
  assert(roundTrippedStatus.schemaVersion === 1, 'status schemaVersion must be 1')
  assert(roundTrippedStatus.kind === 'project-kernel-status', 'status kind is invalid')
  assert(typeof roundTrippedStatus.answers?.unknownOrUnanswered === 'number', 'status answers count missing')
  assert(Array.isArray(roundTrippedStatus.humanRequired), 'status humanRequired must be an array')
  assert(['ready', 'blocked', 'degraded'].includes(roundTrippedStatus.kernelHealth), 'status kernelHealth invalid')

  const report = buildGuardReport([
    { name: 'features-approved', ok: true, messages: ['ok'] },
    { name: 'no-unknown-before-p3', ok: false, messages: ['needs user decision'] },
  ])
  const roundTrippedReport = JSON.parse(JSON.stringify(report))
  assert(roundTrippedReport.ok === false, 'guard report should preserve failed state')
  assert(roundTrippedReport.summary.failed === 1, 'guard report failed count is invalid')
  assert(
    roundTrippedReport.checks[1].category === 'HUMAN_APPROVAL_REQUIRED',
    'human-required guard category is invalid',
  )

  console.log('✓ Project Kernel contract selftest passed')
}

main()
