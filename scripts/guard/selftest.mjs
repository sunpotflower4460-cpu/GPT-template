#!/usr/bin/env node
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runAll } from './index.mjs'

// scripts/guard/ の各チェックが「検出すべき違反を実際に検出できるか」を
// fixtures/ を使って検証するセルフテスト。
// 「確認しました」は成果物として認めない、というcraft/HOW_TO_USE.mdの原則を
// このリポジトリ自身の機械チェックにも適用したもの。

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function setupTempProject(fixtureDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'guard-selftest-'))
  cpSync(fixtureDir, tmp, { recursive: true })
  git(['init', '-q'], tmp)
  git(['config', 'user.email', 'selftest@example.com'], tmp)
  git(['config', 'user.name', 'guard-selftest'], tmp)
  git(['add', '-A'], tmp)
  git(['commit', '-q', '-m', 'initial'], tmp)
  return tmp
}

function checkResult(root, checkName, base) {
  return runAll({ root, base }).find((r) => r.name === checkName)
}

const cases = [
  {
    name: 'pass fixture: 全チェック通過',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const results = runAll({ root })
      return results.every((r) => r.ok)
    },
  },
  {
    name: 'fail/features-approved: features-approved が違反を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/features-approved'))
      return checkResult(root, 'features-approved').ok === false
    },
  },
  {
    name: 'fail/constraints-sourced: constraints-sourced が違反を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/constraints-sourced'))
      return checkResult(root, 'constraints-sourced').ok === false
    },
  },
  {
    name: 'fail/tokens-hardcoded: tokens-hardcoded が違反を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/tokens-hardcoded'))
      return checkResult(root, 'tokens-hardcoded').ok === false
    },
  },
  {
    name: 'fail/entrance-count: entrance-count が違反を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/entrance-count'))
      return checkResult(root, 'entrance-count').ok === false
    },
  },
  {
    name: 'phase-not-bundled: 実装ファイルと同時変更を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      // pass fixture の初回コミットに続けて、PHASE.md と実装ファイルを
      // 同じコミットにまとめて変更し、検出されることを確認する。
      writeFileSync(join(root, 'PHASE.md'), 'P4\n\nこのファイルはユーザーのみが更新する。\n')
      writeFileSync(
        join(root, 'src/screens/login/index.tsx'),
        '// @feature F-001\nexport default function Login() {\n  return "updated"\n}\n',
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'bundle phase with implementation'], root)
      return checkResult(root, 'phase-not-bundled', 'HEAD~1').ok === false
    },
  },
  {
    name: 'phase-not-bundled: PHASE.md 単独変更は誤検知しない',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'PHASE.md'), 'P4\n\nこのファイルはユーザーのみが更新する。\n')
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'phase only'], root)
      return checkResult(root, 'phase-not-bundled', 'HEAD~1').ok === true
    },
  },
  {
    name: 'fail/no-unknown-before-p3: no-unknown-before-p3 が違反を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/no-unknown-before-p3'))
      return checkResult(root, 'no-unknown-before-p3').ok === false
    },
  },
  {
    name: 'no-unknown-before-p3: P0/P1/P2 では未回答があってもスキップする',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/no-unknown-before-p3'))
      writeFileSync(join(root, 'PHASE.md'), 'P1\n\nこのファイルはユーザーのみが更新する。\n')
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'still in P1'], root)
      return checkResult(root, 'no-unknown-before-p3').ok === true
    },
  },
  {
    name: '回帰防止: docs/01-intake/ANSWERS.md の出荷時プレースホルダを偽の1件として数えない',
    expect: () => {
      // テンプレートが実際に出荷する ANSWERS.md（インデントされた見本のみで
      // 実データが無い状態）をそのまま使う。見出しがインデントされていないと
      // 「### Q-001」がパーサーに実エントリとして拾われ、永久に
      // UNKNOWN/未回答1件として検出され続けるバグが実際にあった。
      const root = setupTempProject(join(FIXTURES, 'fail/no-unknown-before-p3'))
      const shippedAnswers = readFileSync(join(__dirname, '../../docs/01-intake/ANSWERS.md'), 'utf8')
      writeFileSync(join(root, 'docs/01-intake/ANSWERS.md'), shippedAnswers)
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'use shipped placeholder ANSWERS.md'], root)
      const result = checkResult(root, 'no-unknown-before-p3')
      // 0件（＝未回答）として弾かれるのは正しい。ただし「Q-001」という
      // 見せかけの1件としてカウントされていないことを確認する。
      return result.ok === false && !result.messages.some((m) => m.includes('Q-001'))
    },
  },
  {
    name: 'no-new-deps: 新規依存の追加を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add dependency'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'no-new-deps: 依存を追加しない変更は誤検知しない',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }, null, 2))
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'no dependency change'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === true
    },
  },
  {
    name: 'guard.config.json: entrance-count が sourceRoot/entranceDirs の上書きを反映する',
    expect: () => {
      // app/routes/ に2件、FEATURES.md の承認+入口ありは1件 → guard.config.json を
      // 読んでいなければ既定の src/ を見て 0件（誤ってpass）になってしまう組み合わせ。
      const root = setupTempProject(join(FIXTURES, 'config-override'))
      return checkResult(root, 'entrance-count').ok === false
    },
  },
  {
    name: 'fail/entrance-count-filename-pattern: ディレクトリ規約の外でも命名規則で検出する',
    expect: () => {
      // src/components/HomeScreen.tsx, SettingsPage.tsx はどちらも
      // src/screens|pages|routes の外にあり、ディレクトリ規約だけでは0件になる。
      const root = setupTempProject(join(FIXTURES, 'fail/entrance-count-filename-pattern'))
      return checkResult(root, 'entrance-count').ok === false
    },
  },
  {
    name: 'no-new-deps: package.json を依存込みで新規追加した場合も検出する',
    expect: () => {
      // fail/features-approved fixture には package.json が無い状態から出発し、
      // 依存入りの package.json をまるごと新規追加するケースを再現する。
      const root = setupTempProject(join(FIXTURES, 'fail/features-approved'))
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add package.json with a dependency'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'fail/no-ai-default-palette-cream: パターン1（クリーム+セリフ+テラコッタ）を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/no-ai-default-palette-cream'))
      return checkResult(root, 'no-ai-default-palette').ok === false
    },
  },
  {
    name: 'fail/no-ai-default-palette-dark: パターン2（ほぼ黒+アシッド）を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/no-ai-default-palette-dark'))
      return checkResult(root, 'no-ai-default-palette').ok === false
    },
  },
  {
    name: 'no-ai-default-palette: パターン3（角丸ゼロ）を検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const cssPath = join(root, 'docs/04-design/tokens.css')
      const css = readFileSync(cssPath, 'utf8').replace('--radius-s: 4px;', '--radius-s: 0px;').replace(
        '--radius-m: 8px;',
        '--radius-m: 0px;',
      )
      writeFileSync(cssPath, css)
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'zero radius'], root)
      return checkResult(root, 'no-ai-default-palette').ok === false
    },
  },
  {
    name: 'no-ai-default-palette: プレースホルダのままなら判定をスキップする',
    expect: () => {
      // pass fixture の tokens.css を、テンプレート本体と同じプレースホルダ形式に差し替える。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const placeholder = ':root {\n  --bg: /* プロジェクトごとに定義 */;\n  --accent: /* プロジェクトごとに定義 */;\n  --ff-display: /* プロジェクトごとに定義 */;\n  --radius-s: /* プロジェクトごとに定義 */;\n  --radius-m: /* プロジェクトごとに定義 */;\n}\n'
      writeFileSync(join(root, 'docs/04-design/tokens.css'), placeholder)
      return checkResult(root, 'no-ai-default-palette').ok === true
    },
  },
  {
    name: 'fail/craft-format: 見出し欠落・なぜ欄の短さを検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'fail/craft-format'))
      const result = checkResult(root, 'craft-format')
      const flagsMissingHeading = result.messages.some((m) => m.includes('C-901') && m.includes('なぜ'))
      const flagsShortWhy = result.messages.some((m) => m.includes('C-902') && m.includes('短すぎ'))
      return result.ok === false && flagsMissingHeading && flagsShortWhy
    },
  },
]

let allPass = true
for (const c of cases) {
  let ok
  try {
    ok = c.expect()
  } catch (e) {
    ok = false
    console.error(e)
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name}`)
  if (!ok) allPass = false
}
console.log(allPass ? '\n✓ セルフテスト全て通過' : '\n✗ セルフテストに失敗があります')
process.exit(allPass ? 0 : 1)
