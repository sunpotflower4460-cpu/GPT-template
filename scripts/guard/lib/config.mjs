import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// entrance-count / tokens-hardcoded / features-approved は既定で `src/` 配下だけを走査する。
// `src/` 以外の構成（例: Next.js の app router、モノレポの packages/*）を使うプロジェクトでは、
// リポジトリ直下に guard.config.json を置いて上書きできる。存在しない場合は完全に既定値のまま動く。
// dependencyPolicy.mode:
//   NONE             既存互換。dependencies/devDependencies を問わず新規追加0件を要求する
//   DEV_ONLY         新規devDependenciesは許可。新規dependencies（production）は禁止（既定）
//   ALLOWLIST        allowlist に列挙した名前の新規追加のみ許可（dependencies/devDependencies問わず）
//   REVIEW_PRODUCTION 新規dependencies（production）はguardを失敗させないが、
//                     severity:'advisory' として報告し人間の確認を促す。新規devDependenciesは許可
//   OPEN             新規依存の追加を一切制限しない
export const DEFAULTS = {
  sourceRoot: 'src',
  entranceDirs: ['screens', 'pages', 'routes'],
  dependencyPolicy: { mode: 'DEV_ONLY', allowlist: [] },
}

// ファイルが存在しない場合は既定値のまま（正常系）。存在するのに壊れている場合は
// 例外を投げる。呼び出し側が黙って既定値にフォールバックすると、意図した
// sourceRoot/entranceDirs とは違う場所を検査した上で「問題なし」と誤って
// 報告してしまうため、設定ミスは静かに握りつぶさず呼び出し元に伝える。
export function loadConfig(root) {
  const configPath = join(root, 'guard.config.json')
  if (!existsSync(configPath)) return { ...DEFAULTS }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  return { ...DEFAULTS, ...parsed }
}
