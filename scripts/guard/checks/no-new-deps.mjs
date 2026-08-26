import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, resolveDefaultBase } from '../lib/git-base.mjs'
import { DEFAULTS } from '../lib/config.mjs'

// 依存関係ポリシー: AGENTS.md「依存関係ポリシー」参照。既定は DEV_ONLY
// （devDependencies は自由、production dependencies は禁止）。
// guard.config.json の dependencyPolicy でモードを上書きできる。
// ルートの package.json の dependencies/devDependencies を base と HEAD で比較し、
// 新規に追加されたパッケージがポリシーに違反していないかを検証する。
// package.json を持たないプロジェクト（他言語スタック）ではスキップする。
//
// base を明示しない場合は、直前コミットとの比較ではなく現在のブランチと
// デフォルトブランチとのマージベースを使う。依存追加だけの小さなコミットを
// 挟んでおいて実装は別コミットにする、という分割で HEAD~1 比較はすり抜けられて
// しまうため、同じブランチ（同じPR）内の全コミットをまとめて見る。
//
// dependencyPolicy は base 時点と作業ツリー（HEAD）時点の両方から読み、
// 両方の判定を満たさない限り通さない（「両者のうち厳しい方」を採用する）。
// base だけを見ると「同じPRでguard.config.jsonを ALLOWLIST/OPEN へ緩めつつ、
// その緩めた設定で自分自身の依存追加を正当化する」という自己参照的な
// すり抜けを許してしまう。逆にHEADだけを見ると、「同じPRでguard.config.jsonを
// NONE へ締めつつ、締める前のbase（例:OPEN）でしか通らない依存追加を混ぜる」
// という逆方向のすり抜け（締めた側の意図をbase側の緩い設定が無効化する）を
// 見逃してしまう。両方を評価してANDを取ることで、どちらの方向の自己参照的な
// すり抜けも防ぐ。
// パース失敗を「依存0件」と区別せず返すための番兵オブジェクト。
const PARSE_FAILED = Symbol('parse-failed')

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// guard.config.json のトップレベルが配列やスカラーの場合（例:
// [{ "dependencyPolicy": {...} }]）、parsed.dependencyPolicy は単に
// undefined になる。dependencyPolicy 自体がスカラー値や配列（例:
// "dependencyPolicy": "NONE"）の場合も、{ ...DEFAULTS, ...value } は
// オブジェクトの mode を上書きせず黙って既定値（DEV_ONLY）へフォールバック
// してしまう。スプレッド演算子は文字列・配列も（インデックスをキーとして）
// 受け入れてしまうため、どちらの階層もプレーンオブジェクトであることを
// 事前に検証する。
function assertGuardConfigShape(parsed, whereForMessage) {
  if (!isPlainObject(parsed)) {
    throw new Error(`${whereForMessage} はJSONオブジェクト（{ ... }の形）である必要があります。配列やスカラー値だとdependencyPolicyが読み取れず黙って既定値(DEV_ONLY)にフォールバックします。`)
  }
  if (parsed.dependencyPolicy !== undefined && !isPlainObject(parsed.dependencyPolicy)) {
    throw new Error(`${whereForMessage} の dependencyPolicy はオブジェクトである必要があります（例: { "mode": "NONE" }）。文字列・配列のままだとmodeが黙って既定値(DEV_ONLY)にフォールバックします。`)
  }
}

function loadDependencyPolicyAt(root, ref) {
  let text
  try {
    text = git(['show', `${ref}:guard.config.json`], root)
  } catch {
    return DEFAULTS.dependencyPolicy
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`base(${ref})時点の guard.config.json が不正なJSONです: ${e.message}`)
  }
  assertGuardConfigShape(parsed, `base(${ref})時点の guard.config.json`)
  return { ...DEFAULTS.dependencyPolicy, ...(parsed.dependencyPolicy ?? {}) }
}

function loadDependencyPolicyFromWorkingTree(root) {
  const path = join(root, 'guard.config.json')
  if (!existsSync(path)) return DEFAULTS.dependencyPolicy
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`guard.config.json（作業ツリー）が不正なJSONです: ${e.message}`)
  }
  assertGuardConfigShape(parsed, 'guard.config.json（作業ツリー）')
  return { ...DEFAULTS.dependencyPolicy, ...(parsed.dependencyPolicy ?? {}) }
}

const KNOWN_MODES = new Set(['NONE', 'DEV_ONLY', 'ALLOWLIST', 'REVIEW_PRODUCTION', 'OPEN'])

// dependencyPolicy の形が使える状態かを検証し、{ mode, allowlist } に正規化する。
// 未知のmodeや配列でないallowlistは、既定へ黙って逃げず設定ミスとして報告する。
function validatePolicyShape(policy) {
  const mode = policy.mode ?? 'DEV_ONLY'
  if (!KNOWN_MODES.has(mode)) {
    return { error: `guard.config.json の dependencyPolicy.mode "${mode}" は未知の値です。次のいずれかにしてください: ${[...KNOWN_MODES].join(', ')}` }
  }
  if (policy.allowlist !== undefined && !Array.isArray(policy.allowlist)) {
    return { error: `guard.config.json の dependencyPolicy.allowlist は配列である必要があります（例: ["zod"]）。文字列のまま渡すと1文字ずつのSetになり、意図したパッケージ名と一致しません。` }
  }
  return { mode, allowlist: new Set(policy.allowlist ?? []) }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function depNamesByKind(pkgJsonText) {
  if (!pkgJsonText) return { dependencies: new Set(), devDependencies: new Set() }
  let pkg
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch {
    return PARSE_FAILED
  }
  // npmはoptionalDependenciesを`npm install --omit=optional`を指定しない限り
  // 既定でインストールする（project-kernel.jsonのruntime.setupは指定していない）。
  // productionのdependenciesと同じ扱いにしないと、optionalDependenciesへ追加する
  // だけでNONE/DEV_ONLY/ALLOWLIST/REVIEW_PRODUCTIONいずれのモードもすり抜けられる。
  //
  // npm 7以降はpeerDependenciesも既定でインストールする。ただし
  // peerDependenciesMeta.<name>.optional: true とマーカーされたpeerだけは
  // 自動インストールされないため、そのマーカーが無いpeerだけをproductionとして
  // 数える（マーカー付きのoptional peerまで数えると、逆に本当にoptionalな
  // peerの追加を過剰にブロックしてしまう）。
  const peerDependencies = pkg.peerDependencies ?? {}
  const peerDependenciesMeta = pkg.peerDependenciesMeta ?? {}
  const requiredPeerNames = Object.keys(peerDependencies).filter((name) => !peerDependenciesMeta[name]?.optional)
  return {
    dependencies: new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...requiredPeerNames,
    ]),
    devDependencies: new Set(Object.keys(pkg.devDependencies ?? {})),
  }
}

function diffAdded(beforeSet, afterSet) {
  return [...afterSet].filter((name) => !beforeSet.has(name))
}

// 1つの解決済みポリシー（mode/allowlist）のもとで、新規依存追加を許可するかどうかを判定する。
function evaluatePolicy(mode, allowlist, { addedProd, addedDev, trulyNew }) {
  if (mode === 'OPEN') {
    return { ok: true, messages: [...describeAdded(addedProd, addedDev), 'dependencyPolicy=OPEN のため許可します'] }
  }

  if (mode === 'ALLOWLIST') {
    const disallowed = trulyNew.filter((name) => !allowlist.has(name))
    if (disallowed.length > 0) {
      return {
        ok: false,
        messages: [
          'allowlist にない新規依存パッケージが追加されています（dependencyPolicy=ALLOWLIST）',
          ...disallowed.map((n) => `  - ${n}`),
        ],
      }
    }
    return {
      ok: true,
      messages: trulyNew.length
        ? [`新規パッケージはすべて allowlist に含まれています: ${trulyNew.join(', ')}`]
        : ['新規の依存パッケージはありません（セクション間の再分類のみ）'],
    }
  }

  if (mode === 'NONE') {
    if (trulyNew.length === 0) {
      return { ok: true, messages: ['新規の依存パッケージはありません（セクション間の再分類のみ、dependencyPolicy=NONE）'] }
    }
    return {
      ok: false,
      messages: ['新規の依存パッケージが追加されています（dependencyPolicy=NONE: 新規依存は0件）', ...trulyNew.map((n) => `  - ${n}`)],
    }
  }

  if (mode === 'REVIEW_PRODUCTION') {
    if (addedProd.length === 0) {
      return { ok: true, messages: [...describeAdded([], addedDev), 'production dependenciesの新規追加はありません'] }
    }
    return {
      ok: true,
      severity: 'advisory',
      messages: [
        '新規のproduction dependencyが追加されています。ブロックはしませんが人間の確認が必要です（dependencyPolicy=REVIEW_PRODUCTION）',
        ...addedProd.map((n) => `  - ${n}`),
        ...(addedDev.length ? ['devDependencies（許可）:', ...addedDev.map((n) => `  - ${n}`)] : []),
      ],
    }
  }

  // DEV_ONLY（既定）: devDependenciesは許可、production dependenciesは禁止。
  if (addedProd.length > 0) {
    return {
      ok: false,
      messages: [
        '新規のproduction dependencyが追加されています（dependencyPolicy=DEV_ONLY: devDependencyのみ許可）',
        ...addedProd.map((n) => `  - ${n}`),
        ...(addedDev.length ? ['devDependencies（許可）:', ...addedDev.map((n) => `  - ${n}`)] : []),
      ],
    }
  }
  return { ok: true, messages: [...describeAdded([], addedDev), 'devDependencyのみの追加のため許可します（dependencyPolicy=DEV_ONLY）'] }
}

export function run({ root, base }) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) {
    return { ok: true, messages: ['package.json が存在しないためスキップ'] }
  }
  if (!existsSync(join(root, '.git'))) {
    return { ok: true, messages: ['.git が見つからないためスキップ（Gitリポジトリ外）'] }
  }

  const resolvedBase = base ?? resolveDefaultBase(root)

  // base 参照そのものが解決できない場合（浅いクローン・最初のコミットなど）はスキップする。
  try {
    git(['rev-parse', '--verify', resolvedBase], root)
  } catch {
    return { ok: true, messages: [`比較対象 ${resolvedBase} を解決できないためスキップ`] }
  }

  // base は解決できるが、その時点で package.json 自体が存在しない場合は
  // 「依存0件だった」とみなす（依存を新規追加したまま package.json ごと
  // 追加するケースを見逃さないため、ここではスキップしない）。
  let beforeText = ''
  try {
    beforeText = git(['show', `${resolvedBase}:package.json`], root)
  } catch {
    beforeText = ''
  }

  const afterText = readFileSync(pkgPath, 'utf8')
  const after = depNamesByKind(afterText)
  if (after === PARSE_FAILED) {
    return { ok: false, messages: ['package.json が不正なJSONです。依存の追加有無を検証できません。修正してください'] }
  }

  const before = depNamesByKind(beforeText)
  const beforeOk = before === PARSE_FAILED ? { dependencies: new Set(), devDependencies: new Set() } : before

  const addedProd = diffAdded(beforeOk.dependencies, after.dependencies)
  const addedDev = diffAdded(beforeOk.devDependencies, after.devDependencies)

  // 新規に追加された依存が0件なら、ポリシーの読み込み・検証より前にここで
  // 抜ける。base時点のguard.config.jsonが壊れていても、そのPRが依存を
  // 追加していない（＝壊れた設定を直すだけのPRである場合を含む）なら
  // ブロックしない。ポリシーの妥当性は「実際に検証が必要なとき」だけ問う。
  if (addedProd.length === 0 && addedDev.length === 0) {
    return { ok: true, messages: ['新規の依存パッケージはありません'] }
  }

  // dependencies⇄devDependencies間の再分類（パッケージ名自体はbase時点で既に
  // 存在していた）は、addedProd/addedDevの単純な区間比較だけでは「新規追加」に
  // 見えてしまう。NONE（新規0件）とALLOWLIST（新規名だけを許可リストと照合）は
  // 「本当にこのプロジェクトに初めて登場した名前か」で判定すべきで、
  // セクション間の移動それ自体を新規追加として扱わない。
  const beforeUnion = new Set([...beforeOk.dependencies, ...beforeOk.devDependencies])
  const afterUnion = new Set([...after.dependencies, ...after.devDependencies])
  const trulyNew = [...afterUnion].filter((name) => !beforeUnion.has(name))

  let basePolicyRaw
  try {
    basePolicyRaw = loadDependencyPolicyAt(root, resolvedBase)
  } catch (e) {
    return { ok: false, messages: [e.message] }
  }
  let headPolicyRaw
  try {
    headPolicyRaw = loadDependencyPolicyFromWorkingTree(root)
  } catch (e) {
    return { ok: false, messages: [e.message] }
  }

  const baseValidated = validatePolicyShape(basePolicyRaw)
  if (baseValidated.error) return { ok: false, messages: [baseValidated.error] }
  const headValidated = validatePolicyShape(headPolicyRaw)
  if (headValidated.error) return { ok: false, messages: [headValidated.error] }

  const diff = { addedProd, addedDev, trulyNew }
  const baseResult = evaluatePolicy(baseValidated.mode, baseValidated.allowlist, diff)

  // base と HEAD のポリシーが実質同一なら、二重に評価・表示する意味がない。
  const samePolicy = baseValidated.mode === headValidated.mode && setsEqual(baseValidated.allowlist, headValidated.allowlist)
  const headResult = samePolicy ? baseResult : evaluatePolicy(headValidated.mode, headValidated.allowlist, diff)

  const ok = baseResult.ok && headResult.ok
  const result = { ok, messages: samePolicy
    ? baseResult.messages
    : [
        `[base policy: ${baseValidated.mode}]`,
        ...baseResult.messages,
        `[current policy: ${headValidated.mode}]`,
        ...headResult.messages,
      ] }
  // severityはokがtrueの場合のみ意味を持つ（REVIEW_PRODUCTIONのadvisory等）。
  // どちらかがadvisoryを返せば全体もadvisoryとして扱う。未設定のままだと
  // runAll側の既定値'blocking'が適用される。
  if (ok && (baseResult.severity === 'advisory' || headResult.severity === 'advisory')) {
    result.severity = 'advisory'
  }
  return result
}

function describeAdded(addedProd, addedDev, includeEmpty = true) {
  const lines = []
  if (addedProd.length) lines.push('dependencies:', ...addedProd.map((n) => `  - ${n}`))
  if (addedDev.length) lines.push('devDependencies:', ...addedDev.map((n) => `  - ${n}`))
  if (lines.length === 0 && includeEmpty) lines.push('新規の依存パッケージはありません')
  return lines
}
