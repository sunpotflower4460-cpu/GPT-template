import { kernelManifestHealth } from '../status.mjs'

// project-kernel.json の健全性は、これまで `status --json` の kernel.exists/
// kernel.valid でしか可視化されていなかった。CI（.github/workflows/guard.yml）が
// 実行するのは `npm run guard` と `npm run guard:selftest` だけで、どちらも
// リポジトリ自身の project-kernel.json の中身までは検証していなかったため、
// このファイルが壊れたり誤って削除されても必須CIチェックはグリーンのまま
// 通ってしまい、外部オーケストレーターだけが宣言された入口を失っていた。
//
// project-kernel.json が存在しない場合はスキップする（他のチェック同様、
// 前提となる仕組みを採用していないプロジェクトをブロックしない — GPT-template
// を必須依存にしないという方針に合わせる）。存在するのに壊れている場合だけ
// 違反として報告する。
export function run({ root }) {
  const health = kernelManifestHealth(root)
  if (!health.exists) {
    return { ok: true, messages: ['project-kernel.json が存在しないためスキップ'] }
  }
  if (!health.valid) {
    return {
      ok: false,
      messages: [
        'project-kernel.json が存在しますが不正です（不正なJSON、またはschemaVersion(=== 1)/kind(=== "ai-project-kernel")/paths(非空オブジェクト、値はtrim後に安全な相対パス文字列)/capabilities(値がすべてboolean)/contextRouting(各tierがpathsの既存キーを指す文字列配列)/runtime(存在する場合、値がすべてnon-empty文字列のオブジェクト)/validation(存在する場合、strategiesが配列で各typeがpush/pull_request/workflow_dispatchのいずれか、required(あれば)がboolean、branches(あれば)が文字列配列、checksが配列でnameを持つ)のいずれかを満たしていません）。',
        '外部オーケストレーターはこのファイルを宣言された入口として読みに来るため、削除ではなく修正するか、意図的に廃止する場合は project-kernel.json 自体を削除してください（削除すればこのチェックはスキップされます）。',
      ],
    }
  }
  return { ok: true, messages: ['project-kernel.json は有効です'] }
}
