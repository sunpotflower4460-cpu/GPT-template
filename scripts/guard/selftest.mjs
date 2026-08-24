#!/usr/bin/env node
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs'
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
