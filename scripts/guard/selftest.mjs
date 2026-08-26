#!/usr/bin/env node
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runAll, CHECKS } from './index.mjs'
import { resolveDefaultBase } from './lib/git-base.mjs'
import { gatherStatus, isValidKernelManifest } from './status.mjs'

// scripts/guard/ の各チェックが「検出すべき違反を実際に検出できるか」を
// fixtures/ を使って検証するセルフテスト。
// 「確認しました」は成果物として認めない、というcraft/HOW_TO_USE.mdの原則を
// このリポジトリ自身の機械チェックにも適用したもの。

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

// 各テストケースが作る一時gitリポジトリを記録し、実行後にまとめて削除する。
// これを怠ると `npm run guard:selftest` を呼ぶたびに（CIも含めて）
// OSの一時ディレクトリにgitリポジトリが積み上がり続ける。
const tempDirs = []

function setupTempProject(fixtureDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'guard-selftest-'))
  tempDirs.push(tmp)
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

// no-new-deps は dependencyPolicy を base commit の guard.config.json から読む
// （HEAD からは読まない。「同じコミットで緩めて同じコミットで使う」を防ぐため）。
// そのためテストでも、ポリシー設定は依存追加とは別のコミットにしておく必要がある。
function setDependencyPolicy(root, dependencyPolicy) {
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ dependencyPolicy }))
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', 'set dependencyPolicy'], root)
}

// このリストは sunpotflower4460-cpu/GPT-PWA-Superbvisor の
// worker/src/projectKernel.test.ts (INVALID_KERNEL_MANIFEST_FIXTURES) と
// 意図的に同じ不正パターンを揃えている。producer側(このファイル、
// isValidKernelManifest())とconsumer側(TSのschema-v1 parser、
// parseProjectKernel())が同じ入力群に対して同じ判定(有効/無効)をすることを、
// それぞれのテストスイートから独立に検証するため。どちらか一方だけ直して
// 契約がずれないよう、この配列を変更したら必ずもう一方の同名リストも
// 同じ変更内容で追随すること。
const VALID_KERNEL_MANIFEST = {
  schemaVersion: 1,
  kind: 'ai-project-kernel',
  paths: { readme: 'README.md' },
  capabilities: {},
  contextRouting: { core: ['readme'] },
}

// 各fixtureはVALID_KERNEL_MANIFESTから正確に1項目だけを崩す。旧
// isValidKernelManifest()はcontextRoutingの「存在」自体を(中身は見ずに)必須
// としていたため、contextRoutingを省いたfixtureは意図した理由(kind欠落など)
// とは無関係に「たまたま」旧実装でも拒否されてしまい、新しいチェックを実際には
// 検証できていなかった。各fixtureに有効なcontextRoutingを含める(対象自体が
// contextRoutingの場合を除く)ことで、旧実装との比較(git stash等)で「このfixture
// は新しいチェックが無ければ旧実装を通り抜けていた」ことを1項目ずつ再現できる。
const INVALID_KERNEL_MANIFEST_FIXTURES = [
  ['missing-kind', { schemaVersion: 1, paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['wrong-kind', { schemaVersion: 1, kind: 'something-else', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['schema-version-string', { schemaVersion: '1', kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['schema-version-unsupported', { schemaVersion: 2, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['capabilities-missing', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, contextRouting: { core: ['readme'] } }],
  ['capabilities-non-boolean', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: { foo: 'yes' }, contextRouting: { core: ['readme'] } }],
  ['paths-empty', { schemaVersion: 1, kind: 'ai-project-kernel', paths: {}, capabilities: {}, contextRouting: {} }],
  ['paths-non-string-value', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 123 }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['paths-unsafe', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: '../escape.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['context-routing-unknown-key', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['missing'] } }],
  ['context-routing-tier-not-array', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: 'readme' } }],
]

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
    name: 'dependencyPolicy=DEV_ONLY（既定）: 新規devDependencyは許可する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { vitest: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add devDependency'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === true
    },
  },
  {
    name: 'dependencyPolicy=DEV_ONLY（既定）: 新規production dependencyとdevDependencyが混在してもproduction側で失敗する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' }, devDependencies: { vitest: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add mixed dependencies'], root)
      const result = checkResult(root, 'no-new-deps', 'HEAD~1')
      return result.ok === false && result.messages.some((m) => m.includes('left-pad')) && result.messages.some((m) => m.includes('vitest'))
    },
  },
  {
    name: 'dependencyPolicy=NONE: guard.config.json で指定すると新規devDependencyも禁止する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'NONE' })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { vitest: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add devDependency under NONE policy'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'dependencyPolicy=ALLOWLIST: 許可リスト外の新規依存を禁止する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'ALLOWLIST', allowlist: ['left-pad'] })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'not-allowed-pkg': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add a non-listed dependency'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'dependencyPolicy=ALLOWLIST: 許可リスト内の新規依存は通す',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'ALLOWLIST', allowlist: ['left-pad'] })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add a listed dependency'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === true
    },
  },
  {
    name: 'dependencyPolicy=REVIEW_PRODUCTION: 新規production dependencyをブロックせずseverity:advisoryで報告する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'REVIEW_PRODUCTION' })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add a production dependency'], root)
      const result = checkResult(root, 'no-new-deps', 'HEAD~1')
      return result.ok === true && result.severity === 'advisory'
    },
  },
  {
    name: 'dependencyPolicy=OPEN: 新規依存を無条件に許可する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'OPEN' })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add a production dependency'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === true
    },
  },
  {
    name: 'no-new-deps: 未知のdependencyPolicy.modeは既定へ黙って逃げず違反として報告する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'NOEN' })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { vitest: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add devDependency under a misspelled mode'], root)
      const result = checkResult(root, 'no-new-deps', 'HEAD~1')
      return result.ok === false && result.messages.some((m) => m.includes('NOEN'))
    },
  },
  {
    name: '回帰防止: dependencyPolicyがオブジェクトでない場合（例: 文字列）は既定へ黙って逃げず違反として報告する',
    expect: () => {
      // { ...DEFAULTS, ...value } はvalueが文字列や配列でもスプレッド自体は
      // 例外を投げず、単にmodeを上書きしないまま黙ってDEV_ONLYへフォールバック
      // してしまう。"dependencyPolicy": "NONE" のような書き間違いを、意図した
      // NONEではなく既定のDEV_ONLYとして黙って解釈しないことを確認する。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, 'NONE')
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { vitest: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add devDependency under a scalar dependencyPolicy value'], root)
      const result = checkResult(root, 'no-new-deps', 'HEAD~1')
      return result.ok === false && result.messages.some((m) => m.includes('dependencyPolicy'))
    },
  },
  {
    name: '回帰防止: guard.config.json のトップレベルが配列やスカラーの場合も既定へ黙って逃げず違反として報告する',
    expect: () => {
      // parsed.dependencyPolicy は、parsedが配列やスカラーの場合はそもそも
      // undefinedになる（配列に.dependencyPolicyというプロパティはない）。
      // dependencyPolicy自体の形だけでなく、guard.config.jsonのトップレベル
      // 自体がオブジェクトであることも検証する。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'guard.config.json'), JSON.stringify([{ dependencyPolicy: { mode: 'NONE' } }]))
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'wrap guard.config.json in a top-level array'], root)
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { vitest: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add devDependency under an array-wrapped guard.config.json'], root)
      const result = checkResult(root, 'no-new-deps', 'HEAD~1')
      return result.ok === false && result.messages.some((m) => m.includes('guard.config.json'))
    },
  },
  {
    name: '回帰防止: base時点のdependencyPolicyが壊れていても、依存を追加しないPR（設定を直すだけのPR含む）はブロックしない',
    expect: () => {
      // base(=HEAD~1)が壊れたdependencyPolicyを持っていても、そのPRが
      // 依存を1件も追加していないなら、ポリシーを検証する必要自体がない。
      // これにより「壊れた設定を直すだけのPR」がその設定の壊れっぷりを
      // 理由にブロックされる、という直せないデッドロックを防ぐ。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, 'NONE')
      // 依存は追加せず、guard.config.jsonを正しい形に直すだけ。
      setDependencyPolicy(root, { mode: 'NONE' })
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === true
    },
  },
  {
    name: '回帰防止: dependencies⇄devDependencies間の再分類は新規依存として扱わない（NONE/ALLOWLIST）',
    expect: () => {
      // left-padをdependenciesからdevDependenciesへ移すだけ（パッケージ自体はbaseに既存）。
      const rootNone = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(rootNone, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2))
      git(['add', '-A'], rootNone)
      git(['commit', '-q', '-m', 'have left-pad as a production dependency'], rootNone)
      setDependencyPolicy(rootNone, { mode: 'NONE' })
      writeFileSync(join(rootNone, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { 'left-pad': '1.0.0' } }, null, 2))
      git(['add', '-A'], rootNone)
      git(['commit', '-q', '-m', 'reclassify left-pad as a devDependency'], rootNone)
      const noneResult = checkResult(rootNone, 'no-new-deps', 'HEAD~1')

      const rootAllowlist = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(rootAllowlist, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2))
      git(['add', '-A'], rootAllowlist)
      git(['commit', '-q', '-m', 'have left-pad as a production dependency'], rootAllowlist)
      setDependencyPolicy(rootAllowlist, { mode: 'ALLOWLIST', allowlist: [] })
      writeFileSync(join(rootAllowlist, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { 'left-pad': '1.0.0' } }, null, 2))
      git(['add', '-A'], rootAllowlist)
      git(['commit', '-q', '-m', 'reclassify left-pad as a devDependency'], rootAllowlist)
      const allowlistResult = checkResult(rootAllowlist, 'no-new-deps', 'HEAD~1')

      return noneResult.ok === true && allowlistResult.ok === true
    },
  },
  {
    name: '回帰防止: no-new-depsは同一コミットでguard.config.jsonを緩めつつ依存を追加する自己参照的なすり抜けを許さない',
    expect: () => {
      // ALLOWLISTへ緩める変更と、その緩めた設定でしか通らないはずの依存追加を
      // "同じコミット"に混ぜた場合、policyはbase（緩める前）から読まれるべきで、
      // baseにはguard.config.json自体が存在しない＝既定のDEV_ONLYで判定されるため、
      // production dependencyの新規追加はブロックされ続けるはず。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'guard.config.json'),
        JSON.stringify({ dependencyPolicy: { mode: 'ALLOWLIST', allowlist: ['left-pad'] } }),
      )
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'bundle policy loosening with the dependency it permits'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: '回帰防止: dependencyPolicy.allowlistが配列でない場合は不正な設定として拒否する（文字列を1文字ずつのSetにしない）',
    expect: () => {
      // パッケージ名を "zod" のままにすると、検証を外してももともと
      // new Set('zod') = {'z','o','d'} に "zod" という要素は存在しないため
      // 誤って通っていた場合でも ok:false になり、この壊れ方を検出できない
      // （Cursor Bugbotの指摘: 有効なリグレッションテストになっていない）。
      // allowlist文字列を構成する1文字だけのパッケージ名("d")を使うことで、
      // 「文字列を1文字ずつのSetとして誤って許可してしまう」壊れ方（検証を
      // 外すと ok:true になってしまう）を実際に検出できるようにする。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'ALLOWLIST', allowlist: 'zod' })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { d: '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add a single-char package matching a character in the malformed string allowlist'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: '回帰防止: no-new-depsは同一コミットでguard.config.jsonを締めつつ、締める前のbaseでしか通らない依存追加を混ぜる逆方向のすり抜けも許さない',
    expect: () => {
      // 緩める方向の自己参照（上のテスト）とは逆に、baseがOPENのまま
      // guard.config.jsonをNONEへ締めるのと同じコミットで、締める前の
      // OPENでしか通らないはずの依存追加を混ぜた場合。policyをbaseだけから
      // 読むと、HEADで意図された「これからはNONE」を無視してOPENのまま
      // 通ってしまう。base/HEAD両方のポリシーを評価し、片方でも禁止するなら
      // 全体を禁止することで、この逆方向のすり抜けも防ぐ。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      setDependencyPolicy(root, { mode: 'OPEN' })
      writeFileSync(
        join(root, 'guard.config.json'),
        JSON.stringify({ dependencyPolicy: { mode: 'NONE' } }),
      )
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'bundle policy tightening with a dependency only the pre-tightening policy would allow'], root)
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'runAll: 各結果に category/severity の既定値が付与される（no-ai-default-paletteを除く）',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const results = runAll({ root })
      return results.every((r) => r.category === 'POLICY_FAILURE')
        && results.filter((r) => r.name !== 'no-ai-default-palette').every((r) => r.severity === 'blocking')
        && results.length === CHECKS.length
    },
  },
  {
    name: 'no-ai-default-palette: 違反時は severity:advisory を返す（CIブロックのok:falseは変えない）',
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
      const result = checkResult(root, 'no-ai-default-palette')
      return result.ok === false && result.severity === 'advisory'
    },
  },
  {
    name: 'status --json: gatherStatus は project-kernel.json の有無/妥当性を報告する',
    expect: () => {
      const withKernel = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(withKernel, 'project-kernel.json'), JSON.stringify(VALID_KERNEL_MANIFEST))
      const okCase = gatherStatus(withKernel)

      const withoutKernel = setupTempProject(join(FIXTURES, 'pass'))
      const missingCase = gatherStatus(withoutKernel)

      const withBadKernel = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(withBadKernel, 'project-kernel.json'), '{ not valid json')
      const invalidCase = gatherStatus(withBadKernel)

      // パース可能なJSONであっても、pathsやcontextRoutingを欠いていれば
      // オーケストレーターは何も読み取れず「有効なマニフェスト」とは言えない。
      // JSON.parseの成否だけをvalidの基準にしない（Codexレビュー指摘）。
      const withShapelessKernel = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(withShapelessKernel, 'project-kernel.json'), '{}')
      const shapelessCase = gatherStatus(withShapelessKernel)

      return okCase.kernel.exists === true && okCase.kernel.valid === true
        && missingCase.kernel.exists === false && missingCase.kernel.valid === false
        && invalidCase.kernel.exists === true && invalidCase.kernel.valid === false
        && shapelessCase.kernel.exists === true && shapelessCase.kernel.valid === false
    },
  },
  {
    name: 'status --json: gatherStatus はPHASE.md/ANSWERS.mdの内容を反映する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const status = gatherStatus(root)
      return status.phase === 'P3' && typeof status.answers.openCount === 'number' && Array.isArray(status.answers.open)
    },
  },
  {
    name: 'kernel-manifest-valid: project-kernel.jsonが存在しない場合はスキップする（GPT-templateを必須依存にしない）',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      return checkResult(root, 'kernel-manifest-valid').ok === true
    },
  },
  {
    name: 'kernel-manifest-valid: 存在して有効なら通す',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'project-kernel.json'), JSON.stringify(VALID_KERNEL_MANIFEST))
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add a valid project-kernel.json'], root)
      return checkResult(root, 'kernel-manifest-valid').ok === true
    },
  },
  {
    name: '回帰防止: kernel-manifest-valid は project-kernel.json が壊れていても npm run guard がグリーンのまま通らないようにする',
    expect: () => {
      // CIは npm run guard / npm run guard:selftest しか実行しないため、
      // status --json だけがkernel.valid:falseを可視化していても、guard自体を
      // 落とさなければ「必須CIチェックはグリーン」のまま外部オーケストレーターの
      // 入口が壊れる。壊れたJSON、パース可能だが形が不正なJSONの両方を検出する。
      const rootBroken = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(rootBroken, 'project-kernel.json'), '{ not valid json')
      git(['add', '-A'], rootBroken)
      git(['commit', '-q', '-m', 'break project-kernel.json JSON'], rootBroken)
      const brokenResult = checkResult(rootBroken, 'kernel-manifest-valid')

      const rootShapeless = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(rootShapeless, 'project-kernel.json'), '{}')
      git(['add', '-A'], rootShapeless)
      git(['commit', '-q', '-m', 'gut project-kernel.json to an empty object'], rootShapeless)
      const shapelessResult = checkResult(rootShapeless, 'kernel-manifest-valid')

      return brokenResult.ok === false && shapelessResult.ok === false
    },
  },
  {
    name: 'kernel-manifest-valid契約: isValidKernelManifestはproducer/consumer共通の有効fixtureを通す',
    expect: () => isValidKernelManifest(VALID_KERNEL_MANIFEST) === true,
  },
  ...INVALID_KERNEL_MANIFEST_FIXTURES.map(([label, manifest]) => ({
    name: `kernel-manifest-valid契約: isValidKernelManifestはproducer/consumer共通の不正fixtureを拒否する(${label})`,
    expect: () => isValidKernelManifest(manifest) === false,
  })),
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
  {
    name: '回帰防止: resolveDefaultBase はデフォルトブランチに直接いてもHEAD自身に収束しない',
    expect: () => {
      // main に直接コミットした状態（guard.yml の push トリガー相当）で
      // merge-base(main, HEAD) が HEAD 自身になり、diffが常に空になっていたバグ。
      const root = setupTempProject(join(FIXTURES, 'pass'))
      mkdirSync(join(root, 'src/screens/second'), { recursive: true })
      writeFileSync(join(root, 'PHASE.md'), 'P4\n\nこのファイルはユーザーのみが更新する。\n')
      writeFileSync(join(root, 'src/screens/second/index.tsx'), '// @feature F-001\nexport default function X() { return null }\n')
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'bundle directly on main'], root)
      const base = resolveDefaultBase(root)
      if (base === 'HEAD' || base === execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()) {
        return false
      }
      return checkResult(root, 'phase-not-bundled').ok === false
    },
  },
  {
    name: '回帰防止: tokens-hardcoded は8桁アルファ付きhexも検出する',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      mkdirSync(join(root, 'src/screens/alpha'), { recursive: true })
      writeFileSync(
        join(root, 'src/screens/alpha/index.tsx'),
        "// @feature F-001\nexport default function X() { return <div style={{ color: '#1a2b3c4d' }} /> }\n",
      )
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'add 8-digit hex'], root)
      return checkResult(root, 'tokens-hardcoded').ok === false
    },
  },
  {
    name: '回帰防止: no-new-deps は不正なpackage.jsonを「依存0件」として黙殺しない',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'package.json'), '{ "dependencies": { "left-pad": "1.0.0", } }')
      const result = checkResult(root, 'no-new-deps', 'HEAD')
      return result.ok === false && result.messages.some((m) => m.includes('不正なJSON'))
    },
  },
  {
    name: '回帰防止: guard.config.json が不正な場合、既定値へ黙って逃げない',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'guard.config.json'), '{ sourceRoot: app }')
      const result = checkResult(root, 'entrance-count')
      return result.ok === false && result.messages.some((m) => m.includes('guard.config.json'))
    },
  },
  {
    name: '回帰防止: entrance-count の入口判定は部分一致（例:「有効化前」の「有」）に反応しない',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'docs/03-scope/FEATURES.md'),
        [
          '# FEATURES.md',
          '',
          '| ID | 機能名 | 状態 | 魂との関係 | 承認日 | 入口の有無 |',
          '|---|---|---|---|---|---|',
          '| F-001 | ログイン | 承認 | 中核 | 2026-01-01 | 有効化前のため未定 |',
        ].join('\n'),
      )
      // pass fixture には既に src/screens/login/ という実際の入口が1件ある。
      // 「有効化前のため未定」を正しく非承認として扱えば、承認された入口0件 <
      // 実際の入口1件で FAIL になるはず。もし旧バグ（部分一致で「有」を拾う）が
      // 残っていれば承認1件とみなされ、1件<=1件で誤ってPASSしてしまう。
      const result = checkResult(root, 'entrance-count')
      return result.ok === false && result.messages[0].includes('承認済みかつ入口ありの機能: 0件')
    },
  },
  {
    name: '回帰防止: PHASE.md がbase..HEADで削除されていてもphase-not-bundledは例外を投げない',
    expect: () => {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      // setupTempProject は git init 時にブランチ名を指定していない
      // （環境の init.defaultBranch 設定に依存する）ため、ブランチ名ではなく
      // 直前コミットのSHAをbaseとして明示し、環境差異の影響を受けないようにする。
      const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      unlinkSync(join(root, 'PHASE.md'))
      mkdirSync(join(root, 'src/screens/second'), { recursive: true })
      writeFileSync(join(root, 'src/screens/second/index.tsx'), '// @feature F-001\nexport default function X() { return null }\n')
      git(['add', '-A'], root)
      git(['commit', '-q', '-m', 'delete PHASE.md alongside impl'], root)
      let result
      try {
        result = checkResult(root, 'phase-not-bundled', initialSha)
      } catch {
        return false // 例外を投げた時点でこのテストは失敗
      }
      return result.ok === false
    },
  },
  {
    name: '回帰防止: runAllはいずれかのチェックが例外を投げても他の結果を道連れにしない',
    expect: () => {
      // 存在しないrootを渡すことで、少なくとも一部のチェックが想定外の状態に
      // 直面する状況を作る。ここでの主張は「プロセスがクラッシュせず、
      // 全チェックについて何らかの結果が返る」ことであり、個々の ok の値は問わない。
      // 件数はCHECKS.lengthから動的に取る（チェックを追加するたびにここを
      // 手で直さなければならない、というハードコードの罠を避ける）。
      let results
      try {
        results = runAll({ root: '/nonexistent-path-for-selftest-xyz' })
      } catch {
        return false
      }
      return results.length === CHECKS.length && results.every((r) => typeof r.ok === 'boolean')
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
for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 削除に失敗してもテスト結果には影響させない（OSの一時領域は最終的にクリーンされる）
  }
}

console.log(allPass ? '\n✓ セルフテスト全て通過' : '\n✗ セルフテストに失敗があります')
// index.mjsと同じ理由（process.exit()はstdoutのflush前にプロセスを終了させうる）で、
// exitCodeを設定してスクリプトを自然に終了させる。
process.exitCode = allPass ? 0 : 1
