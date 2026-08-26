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
// dependencyPolicy 自体は HEAD ではなく base 時点の guard.config.json から読む。
// HEAD（現在のファイルシステム）から読んでしまうと、「同じPRでguard.config.jsonを
// ALLOWLIST/OPENへ緩めつつ、その緩めた設定で自分自身の依存追加を正当化する」という
// phase-not-bundled が想定しているのと同種の自己参照的なすり抜けが可能になる。
// ポリシーの変更とそれを使った依存追加は別PR（別コミット、baseより前）にする。
// パース失敗を「依存0件」と区別せず返すための番兵オブジェクト。
const PARSE_FAILED = Symbol('parse-failed')

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
  return { ...DEFAULTS.dependencyPolicy, ...(parsed.dependencyPolicy ?? {}) }
}

function depNamesByKind(pkgJsonText) {
  if (!pkgJsonText) return { dependencies: new Set(), devDependencies: new Set() }
  let pkg
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch {
    return PARSE_FAILED
  }
  return {
    dependencies: new Set(Object.keys(pkg.dependencies ?? {})),
    devDependencies: new Set(Object.keys(pkg.devDependencies ?? {})),
  }
}

function diffAdded(beforeSet, afterSet) {
  return [...afterSet].filter((name) => !beforeSet.has(name))
}

const KNOWN_MODES = new Set(['NONE', 'DEV_ONLY', 'ALLOWLIST', 'REVIEW_PRODUCTION', 'OPEN'])

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

  let policy
  try {
    policy = loadDependencyPolicyAt(root, resolvedBase)
  } catch (e) {
    return { ok: false, messages: [e.message] }
  }
  const mode = policy.mode ?? 'DEV_ONLY'
  if (!KNOWN_MODES.has(mode)) {
    return {
      ok: false,
      messages: [`guard.config.json の dependencyPolicy.mode "${mode}" は未知の値です。次のいずれかにしてください: ${[...KNOWN_MODES].join(', ')}`],
    }
  }
  if (policy.allowlist !== undefined && !Array.isArray(policy.allowlist)) {
    return {
      ok: false,
      messages: [`guard.config.json の dependencyPolicy.allowlist は配列である必要があります（例: ["zod"]）。文字列のまま渡すと1文字ずつのSetになり、意図したパッケージ名と一致しません。`],
    }
  }
  const allowlist = new Set(policy.allowlist ?? [])

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

function describeAdded(addedProd, addedDev, includeEmpty = true) {
  const lines = []
  if (addedProd.length) lines.push('dependencies:', ...addedProd.map((n) => `  - ${n}`))
  if (addedDev.length) lines.push('devDependencies:', ...addedDev.map((n) => `  - ${n}`))
  if (lines.length === 0 && includeEmpty) lines.push('新規の依存パッケージはありません')
  return lines
}
