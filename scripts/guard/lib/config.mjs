import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// entrance-count / tokens-hardcoded / features-approved は既定で `src/` 配下だけを走査する。
// `src/` 以外の構成（例: Next.js の app router、モノレポの packages/*）を使うプロジェクトでは、
// リポジトリ直下に guard.config.json を置いて上書きできる。存在しない場合は完全に既定値のまま動く。
const DEFAULTS = {
  sourceRoot: 'src',
  entranceDirs: ['screens', 'pages', 'routes'],
}

export function loadConfig(root) {
  const configPath = join(root, 'guard.config.json')
  if (!existsSync(configPath)) return { ...DEFAULTS }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}
