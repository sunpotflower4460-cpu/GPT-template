# gpt-guardrail-template

## 目的

ChatGPTのGitHub連携でリポジトリを直接編集させる際に起きがちな、出典のない制約の捏造・未承認の機能追加・コンセプトの軸の無視・チープなUIという4つの逸脱を、構造的に検出可能にするテンプレート。
GPTを賢くする仕組みではなく、逸脱を発見しやすくして最終レビュー（Claude）のコストを下げるための装置である。
`AGENTS.md` を憲法として運用し、`docs/` 配下の台帳で判断の根拠を追跡する。

## Template repositoryとしての設定手順

1. GitHubでこのリポジトリの Settings を開く
2. General タブの「Template repository」にチェックを入れる
3. 新規プロジェクトは「Use this template」から作成する

## 新規プロジェクト開始時の流れ

1. `PHASE.md` を `P0` にする
2. GPTに「AGENTS.mdを読んで」と伝える（GPTは `npm run status` で現状を把握してから動く）
3. 既存資材があれば棚卸し（`INVENTORY.md`）、なければ質問（`QUESTIONS.md`）
4. ユーザーが承認する
5. 承認済みの範囲のみ実装する
6. `npm run guard` で機械チェック（`.github/workflows/guard.yml` によりPRでも自動実行される）

## 効果の限界

このテンプレートは設計判断の質そのものを上げるものではない。逸脱が起きたときに、それを検出できる可能性が上がるだけである。最終判断は常に人間（Claudeによるレビューを含む）が行う。
