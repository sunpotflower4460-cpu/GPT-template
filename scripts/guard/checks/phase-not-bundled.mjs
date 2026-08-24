import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// AGENTS.md ルール5: PHASE.md を自分で書き換えない
// 「誰が」変更したかは静的には判定できないため、代替の機械的シグナルとして
// 「PHASE.md が実装ファイルと同じ差分に含まれているか」を検出する。
// フェーズ移行は本来ユーザーの承認による独立した変更であるべきで、
// 実装コミットに紛れている場合はレビュー対象として警告する（誤検知はあり得る、という前提のヒューリスティクス）。
function git(args, cwd) {
  // 比較対象が存在しない場合に git がエラーを標準エラーへ出すため、
  // 想定内の失敗（後続の catch で処理する）ではコンソールを汚さないよう抑制する。
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

export function run({ root, base = 'HEAD~1' }) {
  if (!existsSync(join(root, '.git'))) {
    return { ok: true, messages: ['.git が見つからないためスキップ（Gitリポジトリ外）'] }
  }

  let changed
  try {
    changed = git(['diff', '--name-only', base, 'HEAD'], root)
      .split('\n')
      .filter(Boolean)
  } catch {
    return { ok: true, messages: [`比較対象 ${base} を解決できないためスキップ`] }
  }

  if (!changed.includes('PHASE.md')) {
    return { ok: true, messages: ['PHASE.md は変更されていません'] }
  }

  const nonDocChanges = changed.filter(
    (f) => f !== 'PHASE.md' && !f.startsWith('docs/') && !f.startsWith('craft/') && !f.endsWith('.md'),
  )

  if (nonDocChanges.length > 0) {
    return {
      ok: false,
      messages: [
        'PHASE.md が実装ファイルと同じ差分で変更されています。ユーザー承認によるフェーズ移行か確認してください',
        ...nonDocChanges.map((f) => `  - ${f}`),
      ],
    }
  }

  return { ok: true, messages: ['PHASE.md の変更は実装ファイルと分離されています'] }
}
