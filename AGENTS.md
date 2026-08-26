# AGENTS.md

GPT / Codex がリポジトリ編集の前に最初に読む憲法。作業開始前に `npm run status` を実行し、現在のフェーズと未確定事項を把握すること。

外部オーケストレーター（Supervisorなど、GPT自身ではないプログラムからこのリポジトリを扱う場合）は `project-kernel.json` を最初に読む。主要ドキュメントのパス・コンテキストの優先度（CORE/SCOPED/ON_DEMAND）・実行コマンド・検証方式を宣言する。`npm run --silent status -- --json` / `npm run --silent guard -- --json` は同じ情報を機械可読形式で返す（`--silent` を付けないとnpm自身のバナー行がJSONの前に出力され、そのままではパースできない。人間向け出力の後方互換は維持したまま追加した機能であり、既存の出力形式は変わらない）。

## ルール（6条のみ・違反は差し戻し）

1. `FEATURES.md` に承認済みIDのない機能を実装しない
2. `CONSTRAINTS.md` に出典(Q-ID)のない制約を追加しない
3. `tokens.css` にない色・サイズ値をハードコードしない
4. ユーザー回答は原文ママで記録する（要約・言い換え禁止）
5. `PHASE.md` を自分で書き換えない
6. 入口（画面・タブ・設定項目）を承認なしに増やさない

上記および関連する規範は `npm run guard` で機械的に検証できる。

## 三原則

- **不明なとき** → 推測せず `UNKNOWN`
- **思いついたとき** → 実装せず `BACKLOG.md`
- **強化するとき** → 表に足さず、既存を深くする

## フェーズ

| Phase | 状態 | 許可される行為 |
|---|---|---|
| P0 | 受入 | 既存資材の読み取り、`INVENTORY.md` の作成のみ |
| P1 | 質問 | 質問と `ANSWERS.md` への記録のみ。コード禁止 |
| P2 | 設計 | `FEATURES.md` `DECISIONS.md` の起草。コード禁止 |
| P3 | 実装 | 承認済みIDの範囲のみ実装可 |
| P4 | 自己監査 | 差分の自己申告、`HANDOFF.md` 生成 |

P1 に `UNKNOWN` または未回答が1件でも残っている場合、P3に進んではならない。P0 では、既存資材の有無で `INVENTORY.md`／`QUESTIONS.md` を使い分ける（詳細は `QUESTIONS.md`）。

### ガバナンスとランタイムの分離

P0〜P4 は人間の承認を要するプロダクトガバナンスであり、フェーズの移動そのものは人間だけが決める（ルール5）。
これに対し、P3（実装）の内部で行う次の行為は、フェーズ移動ではないため1つずつ人間の確認を挟む必要はない。

```
INSPECT → IMPLEMENT → TEST → DEBUG → REVIEW → REPAIR → VERIFY
```

「実装中に毎回止まる」と「勝手にフェーズを進める」は別の問題であり、混同しない。前者はP3の中で自律的に回してよく、後者はルール5・6で常に禁止する。

### maintainer mode（テンプレート機構自体の変更）

上記のP0〜P4は、**このテンプレートを使って作られた新規プロジェクト**（consumer mode）が従うガバナンスである。
このリポジトリ自身（`sunpotflower4460-cpu/GPT-template`）に対して、`scripts/guard/**`・この`AGENTS.md`・`project-kernel.json`のスキーマ・`README.md`など、テンプレートの機構そのものを保守・進化させる作業は**maintainer modeとしてP0〜P4ゲートの対象外**とする。consumer向けのP0〜P4（例:「P1でコード禁止」）をテンプレート機構自体の変更に適用すると、テンプレート自身を永久に改修できなくなるため。
ただし `npm run guard` / `npm run guard:selftest` を通すことはmaintainer modeでも変わらず必須であり、consumer modeより厳格であるべき（テンプレート自身の壊れは、それを使う全プロジェクトに波及する）。どちらのmodeで作業しているかの判断基準はREADME.md「Template自体の開発（maintainer mode）とTemplateを使うプロジェクト（consumer mode）」を参照する。

## 依存関係ポリシー

新規パッケージの追加可否は `npm run guard` の `no-new-deps` が機械検証する。既定は **DEV_ONLY**（devDependencies は自由、production dependencies の新規追加は禁止）。
リポジトリ直下に `guard.config.json` を置き、`dependencyPolicy` で上書きできる（存在しない場合は既定値のまま）。

| mode | 挙動 |
|---|---|
| `NONE` | dependencies・devDependencies を問わず新規追加0件を要求する（最も厳格） |
| `DEV_ONLY`（既定） | devDependencies は許可。production dependencies は禁止 |
| `ALLOWLIST` | `allowlist` に列挙した名前の新規追加のみ許可 |
| `REVIEW_PRODUCTION` | production dependencies の新規追加はguardを失敗させないが、severity:`advisory` として報告し人間の確認を促す |
| `OPEN` | 新規依存の追加を制限しない |

```json
{
  "dependencyPolicy": { "mode": "ALLOWLIST", "allowlist": ["zod"] }
}
```

厳格さが必要な既存プロジェクトは `mode: "NONE"` に戻せば、以前の「1PRあたり新規依存は0」相当の挙動になる。

## 材料の使い方

> 作業前に `craft/INDEX.md` を読み、該当する項目IDを宣言する。
> 該当なしと判断してよい。無関係な項目を無理に適用しないこと。
> 作った直後に、引いた項目に照らして1回だけ自己修正する。

詳細は `craft/HOW_TO_USE.md` を参照する。

## 応答ヘッダ

すべての応答の冒頭に、次のヘッダをそのまま出力する。

```
【SOUL】<SOUL.md の一文をそのまま引用>
【PHASE】<PHASE.md の値>
【DESIGN】demo / refs
【CRAFT】C-014, C-022 ／ 該当なし
【FEATURE】<承認済みID>
【自発判断】<件数>
```

このヘッダのない応答は「憲法未読」とみなす。

## 応答末尾の固定欄

- 今回 BACKLOG に逃がしたアイデア
- 今回、最も良くしたいと思ったが手を出さなかった点を1つ（「特になし」は不可）
