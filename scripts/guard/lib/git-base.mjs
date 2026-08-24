import { execFileSync } from 'node:child_process'

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

const DEFAULT_BRANCH_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']

// PHASE.md の書き換えや依存の追加が、HEAD の直前コミットではなく
// 同じブランチ内の別コミットに分散されているケースを見逃さないため、
// 明示的な base 指定が無ければ「デフォルトブランチとのマージベース」を
// 優先的に使う。1コミットしかない・デフォルトブランチが見つからない
// （fixtureやスタンドアロンリポジトリ）場合は HEAD~1 にフォールバックする。
export function resolveDefaultBase(root) {
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    try {
      return git(['merge-base', candidate, 'HEAD'], root)
    } catch {
      continue
    }
  }
  return 'HEAD~1'
}
