#!/usr/bin/env node
import { resolve } from 'node:path'
import { run as featuresApproved } from './checks/features-approved.mjs'
import { run as constraintsSourced } from './checks/constraints-sourced.mjs'
import { run as tokensHardcoded } from './checks/tokens-hardcoded.mjs'
import { run as entranceCount } from './checks/entrance-count.mjs'
import { run as phaseNotBundled } from './checks/phase-not-bundled.mjs'
import { run as noUnknownBeforeP3 } from './checks/no-unknown-before-p3.mjs'
import { run as noNewDeps } from './checks/no-new-deps.mjs'
import { run as noAiDefaultPalette } from './checks/no-ai-default-palette.mjs'
import { run as craftFormat } from './checks/craft-format.mjs'

// features-approved / constraints-sourced / tokens-hardcoded / entrance-count / phase-not-bundled は
// AGENTS.md の6条ルールに対応する（「ユーザー回答を原文ママで記録する」ルール4だけは、
// 参照できる原文が存在しないため機械的に検証できず対象外）。
// no-unknown-before-p3 / no-new-deps はフェーズ/実装ポリシーを補強する。
// no-ai-default-palette / craft-format はcraft品質ルールを機械的に補強する。
export const CHECKS = [
  { name: 'features-approved', run: featuresApproved },
  { name: 'constraints-sourced', run: constraintsSourced },
  { name: 'tokens-hardcoded', run: tokensHardcoded },
  { name: 'entrance-count', run: entranceCount },
  { name: 'phase-not-bundled', run: phaseNotBundled },
  { name: 'no-unknown-before-p3', run: noUnknownBeforeP3 },
  { name: 'no-new-deps', run: noNewDeps },
  { name: 'no-ai-default-palette', run: noAiDefaultPalette },
  { name: 'craft-format', run: craftFormat },
]

const CHECK_CATEGORIES = {
  'features-approved': 'POLICY_FAILURE',
  'constraints-sourced': 'POLICY_FAILURE',
  'tokens-hardcoded': 'GUARD_FAILURE',
  'entrance-count': 'POLICY_FAILURE',
  'phase-not-bundled': 'POLICY_FAILURE',
  'no-unknown-before-p3': 'HUMAN_APPROVAL_REQUIRED',
  'no-new-deps': 'POLICY_FAILURE',
  'no-ai-default-palette': 'GUARD_FAILURE',
  'craft-format': 'GUARD_FAILURE',
}

// 個々のチェックが例外を投げても、他のチェック結果まで失わない。
export function runAll(opts) {
  return CHECKS.map(({ name, run }) => {
    try {
      return { name, ...run(opts) }
    } catch (e) {
      return {
        name,
        ok: false,
        messages: [`予期しないエラーで検査を完了できませんでした: ${e instanceof Error ? e.message : String(e)}`],
      }
    }
  })
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = resolve(argv[++i])
    if (argv[i] === '--base') args.base = argv[++i]
    if (argv[i] === '--json') args.json = true
  }
  return args
}

export function buildGuardReport(results) {
  const checks = results.map(({ name, ok, messages }) => ({
    id: name,
    status: ok ? 'passed' : 'failed',
    ok: Boolean(ok),
    category: ok ? null : (CHECK_CATEGORIES[name] ?? 'GUARD_FAILURE'),
    severity: ok ? 'info' : 'error',
    messages: Array.isArray(messages) ? messages : [],
  }))
  const failed = checks.filter((check) => !check.ok)
  return {
    schemaVersion: 1,
    kind: 'project-kernel-guard-report',
    ok: failed.length === 0,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      failureCategories: [...new Set(failed.map((check) => check.category).filter(Boolean))],
    },
    checks,
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const results = runAll(opts)
  const report = buildGuardReport(results)

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }

  for (const { name, ok, messages } of results) {
    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}`)
    for (const m of messages) console.log(`  ${m}`)
  }
  console.log(`\n${report.ok ? '✓ 全チェック通過' : '✗ 違反があります'}`)
  process.exit(report.ok ? 0 : 1)
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) main()
