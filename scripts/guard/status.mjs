#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readTable } from './lib/markdown-table.mjs'

// GPT がセッション開始時に状況を素早く把握するための一括表示。
// PHASE.md / SOUL.md / FEATURES.md / CONSTRAINTS.md / ANSWERS.md / BACKLOG.md を
// 個別に読みに行く代わりに、この1コマンドで要点を確認できるようにする。
//
// --json を付けると同じ情報を machine readable な形で返す（外部オーケストレーター
// が個々のMarkdownをパースし直さずに済むようにするため）。JSON側は既存の
// Markdown群から都度生成する投影(projection)であり、これ自体を第二の真実の
// 情報源にはしない。

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

function kernelManifestHealth(root) {
  const path = join(root, 'project-kernel.json')
  if (!existsSync(path)) return { exists: false, valid: false }
  try {
    JSON.parse(readFileSync(path, 'utf8'))
    return { exists: true, valid: true }
  } catch {
    return { exists: true, valid: false }
  }
}

// Markdown群を読み、人間向け表示・JSON表示どちらもここから作る単一の集計。
// selftest.mjs から直接importして検証できるようexportする。
export function gatherStatus(root) {
  const phase = readFirstLine(join(root, 'PHASE.md'))
  const soul = soulOneLiner(root)
  const kernel = kernelManifestHealth(root)

  let features = null
  const featuresPath = join(root, 'docs/03-scope/FEATURES.md')
  if (existsSync(featuresPath)) {
    const rows = readTable(featuresPath).filter((r) => r.ID?.trim())
    const byState = {}
    for (const row of rows) {
      const state = row['状態']?.trim() || '(未設定)'
      byState[state] = (byState[state] ?? 0) + 1
    }
    features = { total: rows.length, byState }
  }

  let constraints = null
  const constraintsPath = join(root, 'docs/02-decisions/CONSTRAINTS.md')
  if (existsSync(constraintsPath)) {
    const rows = readTable(constraintsPath).filter((r) => r['制約']?.trim())
    const missing = rows.filter((r) => !r['出典(Q-ID)']?.trim())
    constraints = { total: rows.length, missingSource: missing.length }
  }

  const entries = answersEntries(root)
  const open = entries.filter((e) => {
    // \s* は改行にもマッチするため、値が空欄の行では次の行の内容まで
    // 誤って取り込んでしまう。[ \t]* に限定して行内だけを見る。
    const confidence = e.match(/確度[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    const answer = e.match(/回答（原文ママ）[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    return confidence === 'UNKNOWN' || confidence === '' || answer === ''
  })
  const answers = { total: entries.length, openCount: open.length, open: open.map((e) => e.split('\n')[0].trim()) }

  let backlog = null
  const backlogPath = join(root, 'docs/03-scope/BACKLOG.md')
  if (existsSync(backlogPath)) {
    const rows = readTable(backlogPath).filter((r) => Object.values(r).some((v) => v?.trim()))
    backlog = { total: rows.length }
  }

  return { phase, soul, kernel, features, constraints, answers, backlog }
}

function printHuman(status) {
  const lines = []
  lines.push('=== プロジェクト状況スナップショット ===')
  lines.push('')
  lines.push(`PHASE: ${status.phase ?? '(PHASE.md が見つかりません)'}`)
  lines.push(`SOUL: ${status.soul || '(未記入)'}`)

  if (status.features) {
    lines.push('')
    lines.push(`FEATURES.md: 計${status.features.total}件`)
    for (const [state, count] of Object.entries(status.features.byState)) {
      lines.push(`  ${state}: ${count}件`)
    }
  }

  if (status.constraints) {
    lines.push('')
    lines.push(`CONSTRAINTS.md: 計${status.constraints.total}件（出典なし: ${status.constraints.missingSource}件）`)
  }

  lines.push('')
  lines.push(`ANSWERS.md: 計${status.answers.total}件（UNKNOWN・未回答: ${status.answers.openCount}件）`)
  for (const e of status.answers.open) {
    lines.push(`  - ${e}`)
  }

  if (status.backlog) {
    lines.push('')
    lines.push(`BACKLOG.md: 計${status.backlog.total}件`)
  }

  lines.push('')
  lines.push('次のアクション:')
  lines.push('  npm run guard          — 機械チェックを実行')
  lines.push('  npm run guard:selftest — guardチェック自体の健全性を確認')

  console.log(lines.join('\n'))
}

function main() {
  const root = process.cwd()
  const json = process.argv.includes('--json')
  const status = gatherStatus(root)

  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, ...status }, null, 2))
    return
  }

  printHuman(status)
}

// index.mjs と同じガード。selftest.mjs が gatherStatus を直接importして検証できる
// ようにexportした結果、このファイルをimportしただけでmain()（実stdout出力・
// process.cwd()読み取り）が副作用として走ってしまわないようにする。
const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) main()
