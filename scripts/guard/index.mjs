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
// no-unknown-before-p3 / no-new-deps は、6条とは別にAGENTS.md本文（フェーズ表の注記、
// 「5. 依存関係ポリシー」）で明言されている規範に対応する。
// no-ai-default-palette / craft-format は craft/situations/traps.md（C-050）と
// HOW_TO_USE.md の趣旨を、tokens.css が実値で埋まった段階・craft/ 自体が
// 将来拡張された段階でも機械的に守らせるための追加チェック。
//
// category は現時点では全チェック共通で POLICY_FAILURE（台帳・実装がテンプレートの
// 規範に反している）。CODE_FAILURE等の他カテゴリは、このリポジトリ自身にコード
// テスト・ビルドの概念ができた時点で初めて意味を持つため、先取りして分岐を
// 作らない（project-kernel.json 同様「今わかっている範囲だけ」を反映する）。
export const CHECKS = [
  { name: 'features-approved', category: 'POLICY_FAILURE', run: featuresApproved },
  { name: 'constraints-sourced', category: 'POLICY_FAILURE', run: constraintsSourced },
  { name: 'tokens-hardcoded', category: 'POLICY_FAILURE', run: tokensHardcoded },
  { name: 'entrance-count', category: 'POLICY_FAILURE', run: entranceCount },
  { name: 'phase-not-bundled', category: 'POLICY_FAILURE', run: phaseNotBundled },
  { name: 'no-unknown-before-p3', category: 'POLICY_FAILURE', run: noUnknownBeforeP3 },
  { name: 'no-new-deps', category: 'POLICY_FAILURE', run: noNewDeps },
  { name: 'no-ai-default-palette', category: 'POLICY_FAILURE', run: noAiDefaultPalette },
  { name: 'craft-format', category: 'POLICY_FAILURE', run: craftFormat },
]

// 個々のチェックが例外を投げると、他の全チェックの結果ごと `npm run guard` の
// プロセス全体が生のスタックトレースで落ちてしまう（実際に phase-not-bundled で
// 発生した：PHASE.md がdiff範囲内で削除されているとき、想定していない
// `git show HEAD:PHASE.md` の失敗がそのまま伝播していた）。
// 各チェックの内部で個別に握り潰すのではなく、ここで一括して受け止め、
// 1件の想定外の失敗が他のチェックの実行や結果表示を妨げないようにする。
//
// 各結果には name/category/severity の既定値を先に置き、run() の戻り値をそれに
// 上書きする形で spread する。severity はチェック自身が返さない限り 'blocking'
// （npm run guard の exit codeに影響する既存の全チェックの挙動）。
// no-ai-default-palette や no-new-deps（REVIEW_PRODUCTIONモード時）のように
// 「okはtrue/falseのままCI挙動は変えないが、machine readableな出力では
// ブロッキング違反と区別したい」場合だけ、チェック自身が severity:'advisory'
// を返して上書きする。
export function runAll(opts) {
  return CHECKS.map(({ name, category, run }) => {
    try {
      return { name, category, severity: 'blocking', ...run(opts) }
    } catch (e) {
      return { name, category, severity: 'blocking', ok: false, messages: [`予期しないエラーで検査を完了できませんでした: ${e.message}`] }
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

function main() {
  const { json, ...opts } = parseArgs(process.argv.slice(2))
  const results = runAll(opts)
  const allOk = results.every((r) => r.ok)

  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, ok: allOk, checks: results }, null, 2))
    process.exit(allOk ? 0 : 1)
  }

  for (const { name, ok, severity, messages } of results) {
    const label = ok ? 'PASS' : severity === 'advisory' ? 'ADVISORY' : 'FAIL'
    console.log(`\n[${label}] ${name}`)
    for (const m of messages) console.log(`  ${m}`)
  }
  console.log(`\n${allOk ? '✓ 全チェック通過' : '✗ 違反があります'}`)
  process.exit(allOk ? 0 : 1)
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) main()
