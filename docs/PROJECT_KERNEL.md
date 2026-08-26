# Project Kernel contract

このテンプレートは、人間が読む台帳だけでなく、AI DEV DECKなどの監督層が安全に読み取れる **Project Kernel** として利用できる。

## 基本原則

- `project-kernel.json` は capability manifest であり、プロジェクトの真実そのものではない。
- SOUL / ANSWERS / DECISIONS / CONSTRAINTS / FEATURES / HANDOFF など既存ファイルが引き続き正本である。
- `npm run status -- --json` と `npm run guard -- --json` は正本から生成される machine-readable projection であり、独立DBとして編集しない。
- Project KernelがないリポジトリでもAI開発は可能であり、このmanifestを外部ツールのhard dependencyにしてはいけない。

## Consumer mode

このテンプレートから作られた通常プロジェクトで使う既定モード。

- `PHASE.md` の変更権限はユーザーにある。
- 承認済みFEATUREの範囲だけを実装する。
- P0/P1/P2では既存のgovernance rulesに従い、実装コードへ進まない。
- P3以降は、承認済みscope内の `INSPECT → IMPLEMENT → TEST → DEBUG → REVIEW → REPAIR → VERIFY` をroutine confirmationなしで反復してよい。

## Maintainer mode

このテンプレート自身のguard、manifest、docs、craft、CIなど **template machineryを保守する作業** に使う概念上のモード。

Consumer projectのP0/P1/P2 code prohibitionを、テンプレート基盤そのものの保守不能を意味する規則として解釈しない。ただし、既存guardやhuman gateを黙って無効化する権限を与えるものでもない。変更はPR・CI・レビューで検証する。

## Context routing

`project-kernel.json` はプロジェクト知識を次の3層として宣言する。

- `core`: 原則として毎回重要なSOUL、制約、承認済みscope。
- `scoped`: UIや設計など、現在のtaskに関係するときだけ読む情報。
- `onDemand`: 過去の回答、意思決定、backlog、handoffなど、必要時にだけ読む情報。

目的は「全部を毎回promptへ入れる」ことではなく、必要な文脈だけを選ぶことである。

## Runtime and validation contracts

`runtime` はProject Kernel自身が提供する機械コマンドを宣言する。`validation` はGitHub/CI側で何を待つべきかを示す。

schema v1では、現在の実態に合わせてPR validationを宣言している。`guard` はmachine/policy guard、`check-approval` はhuman approval gateとしてカテゴリを分ける。

外部Supervisorはこの区別を使い、human approval failureをcode failureとして自動修正し続けてはいけない。

## Compatibility

既存の次のコマンドはそのまま維持する。

```bash
npm run status
npm run guard
npm run guard:selftest
```

machine-readable利用時だけ次を使う。

```bash
npm run status -- --json
npm run guard -- --json
npm run contract:selftest
```
