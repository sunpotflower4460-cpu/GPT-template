import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readTable } from '../lib/markdown-table.mjs'
import { loadConfig } from '../lib/config.mjs'

// AGENTS.md ルール6: 入口（画面・タブ・設定項目）を承認なしに増やさない
// <sourceRoot>/<entranceDirs[i]> 直下のディレクトリ数を「実際の入口数」とみなし、
// FEATURES.md で「承認」かつ「入口の有無」ありの件数と突合する。
// 既定は src/screens, src/pages, src/routes。プロジェクト構成が異なる場合は
// guard.config.json の sourceRoot / entranceDirs で上書きできる。
function countEntranceDirs(root, config) {
  let count = 0
  for (const dir of config.entranceDirs) {
    const full = join(root, config.sourceRoot, dir)
    if (!existsSync(full)) continue
    count += readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory()).length
  }
  return count
}

export function run({ root }) {
  const featuresPath = join(root, 'docs/03-scope/FEATURES.md')
  if (!existsSync(featuresPath)) {
    return { ok: false, messages: [`FEATURES.md が見つかりません: ${featuresPath}`] }
  }

  const rows = readTable(featuresPath).filter((r) => r.ID?.trim())
  const approvedWithEntrance = rows.filter(
    (r) => r['状態']?.trim() === '承認' && /あり|有/.test(r['入口の有無'] ?? ''),
  ).length

  const actualEntrances = countEntranceDirs(root, loadConfig(root))
  const ok = actualEntrances <= approvedWithEntrance
  const messages = [
    `承認済みかつ入口ありの機能: ${approvedWithEntrance}件 / 実際の入口ディレクトリ: ${actualEntrances}件`,
  ]
  if (!ok) {
    messages.push('実際の入口数が承認された入口数を超えています。FEATURES.md の承認状況と突合してください')
  }
  return { ok, messages }
}
