#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

const SUPPORTED_KERNEL_SCHEMA_VERSION = 1

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// sunpotflower4460-cpu/GPT-PWA-Superbvisor の worker/src/projectKernel.ts
// (assertSafeManifestPath) と同じ安全性チェック。
function isSafeManifestPathValue(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  if (value.split('/').includes('..')) return false
  return true
}

function isValidKernelPaths(paths) {
  if (!isPlainObject(paths)) return false
  const entries = Object.entries(paths)
  if (entries.length === 0) return false
  return entries.every(([, value]) => isSafeManifestPathValue(value))
}

function isValidKernelCapabilities(capabilities) {
  if (!isPlainObject(capabilities)) return false
  return Object.values(capabilities).every((value) => typeof value === 'boolean')
}

// contextRouting自体は任意項目（consumer側のTS schema-v1 parserも同様に省略可）。
// 存在する場合だけ、各tier(core/scoped/onDemand)がpathsのキーを指す文字列配列に
// なっていることを検証する。ここを飛ばすと、pathsに存在しないキーを参照する
// contextRoutingでもこのリポジトリのguardはグリーンのまま、consumer側の
// schema-v1 parserだけが例外を投げてGENERIC_REPOへ落ちる — 外部オーケストレーターが
// 宣言された入口を失っているのに、producer側のCIは何も気づかないという非対称な
// 壊れ方になる。
function isValidKernelContextRouting(contextRouting, paths) {
  if (contextRouting === undefined) return true
  if (!isPlainObject(contextRouting)) return false
  for (const tier of ['core', 'scoped', 'onDemand']) {
    const items = contextRouting[tier]
    if (items === undefined) continue
    if (!Array.isArray(items)) return false
    for (const pathKey of items) {
      if (typeof pathKey !== 'string' || !pathKey.trim()) return false
      if (!(pathKey in paths)) return false
    }
  }
  return true
}

// JSON.parseが成功しただけでは「有効なマニフェスト」とは言えない（例: `{}` も
// 有効なJSONだが、paths/contextRoutingを持たず、オーケストレーターはここから
// 何も読み取れない）。sunpotflower4460-cpu/GPT-PWA-Superbvisor 側の schema-v1
// parser（worker/src/projectKernel.ts の parseProjectKernel）が実際に要求して
// いるのと同じ契約まで検証する — producer側(このファイル)がそれより緩いと、この
// リポジトリのguardはグリーンのまま、consumer側だけがKERNEL_AWAREとして読めず
// GENERIC_REPOへ黙って落ちる状態を作れてしまう（schemaVersionが1以外の任意の
// 数値でも通る、kind/capabilitiesを検証しない、pathsが空でも通る、
// contextRoutingがpathsに存在しないキーを参照していても通る、など）。
// scripts/guard/checks/kernel-manifest-valid.mjs からも同じ判定を使うため export する
// （CIの `npm run guard` と `status --json` とで判定基準がずれないようにする）。
export function isValidKernelManifest(parsed) {
  if (!isPlainObject(parsed)) return false
  if (parsed.schemaVersion !== SUPPORTED_KERNEL_SCHEMA_VERSION) return false
  if (parsed.kind !== 'ai-project-kernel') return false
  if (!isValidKernelPaths(parsed.paths)) return false
  if (!isValidKernelCapabilities(parsed.capabilities)) return false
  if (!isValidKernelContextRouting(parsed.contextRouting, parsed.paths)) return false
  return true
}

export function kernelManifestHealth(root) {
  const path = join(root, 'project-kernel.json')
  if (!existsSync(path)) return { exists: false, valid: false }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { exists: true, valid: isValidKernelManifest(parsed) }
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
// file://${resolve(...)} を手組みすると、パスに空白や非ASCII文字が含まれる場合に
// import.meta.url（percent-encodeされる）と食い違い isMain が誤ってfalseになる。
// pathToFileURL() で同じエンコード規則を通してから比較する。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
