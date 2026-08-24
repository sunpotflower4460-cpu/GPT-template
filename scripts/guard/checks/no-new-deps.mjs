import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// AGENTS.md「5. 実装のルール」: 1PRあたり新規依存は0
// ルートの package.json の dependencies/devDependencies を base と HEAD で比較し、
// 新規に追加されたパッケージがないかを検証する。
// package.json を持たないプロジェクト（他言語スタック）ではスキップする。
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function depNames(pkgJsonText) {
  if (!pkgJsonText) return new Set()
  try {
    const pkg = JSON.parse(pkgJsonText)
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  } catch {
    return new Set()
  }
}

export function run({ root, base = 'HEAD~1' }) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) {
    return { ok: true, messages: ['package.json が存在しないためスキップ'] }
  }
  if (!existsSync(join(root, '.git'))) {
    return { ok: true, messages: ['.git が見つからないためスキップ（Gitリポジトリ外）'] }
  }

  // base 参照そのものが解決できない場合（浅いクローン・最初のコミットなど）はスキップする。
  try {
    git(['rev-parse', '--verify', base], root)
  } catch {
    return { ok: true, messages: [`比較対象 ${base} を解決できないためスキップ`] }
  }

  // base は解決できるが、その時点で package.json 自体が存在しない場合は
  // 「依存0件だった」とみなす（依存を新規追加したまま package.json ごと
  // 追加するケースを見逃さないため、ここではスキップしない）。
  let beforeText = ''
  try {
    beforeText = git(['show', `${base}:package.json`], root)
  } catch {
    beforeText = ''
  }

  const afterText = readFileSync(pkgPath, 'utf8')
  const before = depNames(beforeText)
  const after = depNames(afterText)
  const added = [...after].filter((name) => !before.has(name))

  if (added.length > 0) {
    return {
      ok: false,
      messages: ['新規の依存パッケージが追加されています（1PRあたり新規依存は0）', ...added.map((n) => `  - ${n}`)],
    }
  }
  return { ok: true, messages: ['新規の依存パッケージはありません'] }
}
