#!/usr/bin/env node
import { resolve } from 'node:path'
import { run as featuresApproved } from './checks/features-approved.mjs'
import { run as constraintsSourced } from './checks/constraints-sourced.mjs'
import { run as tokensHardcoded } from './checks/tokens-hardcoded.mjs'
import { run as entranceCount } from './checks/entrance-count.mjs'
import { run as phaseNotBundled } from './checks/phase-not-bundled.mjs'

// AGENTS.md の6条ルールのうち、「ユーザー回答を原文ママで記録する」（ルール4）は
// 参照できる原文が存在しないため機械的に検証できない。残る5条それぞれに
// 対応するチェックのみを実装する。
export const CHECKS = [
  { name: 'features-approved', run: featuresApproved },
  { name: 'constraints-sourced', run: constraintsSourced },
  { name: 'tokens-hardcoded', run: tokensHardcoded },
  { name: 'entrance-count', run: entranceCount },
  { name: 'phase-not-bundled', run: phaseNotBundled },
]

export function runAll(opts) {
  return CHECKS.map(({ name, run }) => ({ name, ...run(opts) }))
}

function parseArgs(argv) {
  const args = { root: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = resolve(argv[++i])
    if (argv[i] === '--base') args.base = argv[++i]
  }
  return args
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const results = runAll(opts)

  let allOk = true
  for (const { name, ok, messages } of results) {
    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}`)
    for (const m of messages) console.log(`  ${m}`)
    if (!ok) allOk = false
  }
  console.log(`\n${allOk ? '✓ 全チェック通過' : '✗ 違反があります'}`)
  process.exit(allOk ? 0 : 1)
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) main()
