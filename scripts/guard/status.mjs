#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readTable } from './lib/markdown-table.mjs'

// GPT がセッション開始時に状況を素早く把握するための一括表示。
// human-readable outputは既存利用者向けに維持し、--json指定時だけ
// AI DEV DECK等が安定して読めるmachine-readable projectionを返す。

function readFirstLine(path) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8').split('\n')[0].trim()
}

function soulOneLiner(root) {
  const path = join(root, 'docs/00-soul/SOUL.md')
  if (!existsSync(path)) return null
  const content = readFileSync(path, 'utf8')
  const section = content.split('## 一文で言うと')[1]?.split('\n## ')[0] ?? ''
  const line = section
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<!--') && !l.startsWith('（'))
  return line ?? null
}

function answersEntries(root) {
  const path = join(root, 'docs/01-intake/ANSWERS.md')
  if (!existsSync(path)) return []
  const content = readFileSync(path, 'utf8')
  return content.split(/^### /m).slice(1)
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = resolve(argv[++i])
    if (argv[i] === '--json') args.json = true
  }
  return args
}

export function buildStatusSnapshot(root = process.cwd()) {
  const phase = readFirstLine(join(root, 'PHASE.md'))
  const soul = soulOneLiner(root)

  const featuresPath = join(root, 'docs/03-scope/FEATURES.md')
  const featureRows = existsSync(featuresPath)
    ? readTable(featuresPath).filter((r) => r.ID?.trim())
    : []
  const featuresByState = {}
  for (const row of featureRows) {
    const state = row['状態']?.trim() || '(未設定)'
    featuresByState[state] = (featuresByState[state] ?? 0) + 1
  }
  const approvedFeatures = featureRows
    .filter((row) => row['状態']?.trim() === '承認')
    .map((row) => row.ID.trim())

  const constraintsPath = join(root, 'docs/02-decisions/CONSTRAINTS.md')
  const constraintRows = existsSync(constraintsPath)
    ? readTable(constraintsPath).filter((r) => r['制約']?.trim())
    : []
  const unsourcedConstraints = constraintRows.filter((r) => !r['出典(Q-ID)']?.trim())

  const entries = answersEntries(root)
  const openAnswers = entries.filter((entry) => {
    const confidence = entry.match(/確度[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    const answer = entry.match(/回答（原文ママ）[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    return confidence === 'UNKNOWN' || confidence === '' || answer === ''
  })
  const unknownItems = openAnswers.map((entry) => entry.split('\n')[0].trim()).filter(Boolean)

  const backlogPath = join(root, 'docs/03-scope/BACKLOG.md')
  const backlogRows = existsSync(backlogPath)
    ? readTable(backlogPath).filter((r) => Object.values(r).some((v) => v?.trim()))
    : []

  const implementationPhase = phase === 'P3' || phase === 'P4'
  const humanRequired = []
  if (implementationPhase && openAnswers.length > 0) {
    humanRequired.push({
      id: 'resolve-unknowns-before-implementation',
      category: 'HUMAN_APPROVAL_REQUIRED',
      message: 'P3/P4ですがUNKNOWNまたは未回答が残っています。ユーザー判断が必要です。',
    })
  }

  const requiredPaths = [
    'PHASE.md',
    'docs/00-soul/SOUL.md',
    'docs/02-decisions/CONSTRAINTS.md',
    'docs/03-scope/FEATURES.md',
  ]
  const missingRequiredPaths = requiredPaths.filter((path) => !existsSync(join(root, path)))
  const kernelHealth = missingRequiredPaths.length > 0
    ? 'degraded'
    : humanRequired.length > 0 || unsourcedConstraints.length > 0
      ? 'blocked'
      : 'ready'

  return {
    schemaVersion: 1,
    kind: 'project-kernel-status',
    manifestPresent: existsSync(join(root, 'project-kernel.json')),
    governancePhase: phase,
    soul,
    implementationAllowedByPhase: implementationPhase,
    features: {
      total: featureRows.length,
      byState: featuresByState,
      approved: approvedFeatures,
    },
    constraints: {
      total: constraintRows.length,
      unsourced: unsourcedConstraints.length,
    },
    answers: {
      total: entries.length,
      unknownOrUnanswered: openAnswers.length,
      items: unknownItems,
    },
    backlogCount: backlogRows.length,
    humanRequired,
    missingRequiredPaths,
    kernelHealth,
  }
}

function renderHuman(snapshot) {
  const lines = []
  lines.push('=== プロジェクト状況スナップショット ===')
  lines.push('')
  lines.push(`PHASE: ${snapshot.governancePhase ?? '(PHASE.md が見つかりません)'}`)
  lines.push(`SOUL: ${snapshot.soul || '(未記入)'}`)

  lines.push('')
  lines.push(`FEATURES.md: 計${snapshot.features.total}件`)
  for (const [state, count] of Object.entries(snapshot.features.byState)) {
    lines.push(`  ${state}: ${count}件`)
  }

  lines.push('')
  lines.push(`CONSTRAINTS.md: 計${snapshot.constraints.total}件（出典なし: ${snapshot.constraints.unsourced}件）`)

  lines.push('')
  lines.push(`ANSWERS.md: 計${snapshot.answers.total}件（UNKNOWN・未回答: ${snapshot.answers.unknownOrUnanswered}件）`)
  for (const item of snapshot.answers.items) lines.push(`  - ${item}`)

  lines.push('')
  lines.push(`BACKLOG.md: 計${snapshot.backlogCount}件`)

  lines.push('')
  lines.push('次のアクション:')
  lines.push('  npm run guard          — 機械チェックを実行')
  lines.push('  npm run guard:selftest — guardチェック自体の健全性を確認')
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const snapshot = buildStatusSnapshot(args.root)
  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  console.log(renderHuman(snapshot))
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) main()
