# Kyoten

![Kyoten](./docs/images/kyoten-logo.png)

> **AI コーディングエージェントのための個人用ホームベース** — プログラミング、ドキュメント作成、リサーチ、翻訳、生成 AI 作業を 1 つの共有ワークスペースに集約します。✨

[![Test CI](https://github.com/shino369/kyoten/actions/workflows/test.yml/badge.svg)](https://github.com/shino369/kyoten/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

🌐 [English](./README.md) · **日本語** · [繁體中文](./README.zh-TW.md)

---

**Kyoten（拠点）** は、AI エージェント関連の設定をすべて 1 つのクリーンでポータブルなリポジトリにまとめるワークスペースです。ツールごとにルール、フック、スキル、メモリを重複設定する必要はありません。この拠点を一度セットアップするだけで、**Claude Code**、**Codex**、**Antigravity CLI (`agy`)**、**DeepSeek Harness (`dsh`)** をシームレスに使い分けられます。

すべてプレーンな Node.js ESM で動作し、ランタイム依存ゼロ・モノレポ不要・ビルドステップ不要のシンプルな構成です。リポジトリをクローンして初回セットアップを実行したら、あとはお好みのコーディングエージェントをこのワークスペース内で起動するだけです。🌿

## ✨ なぜ Kyoten なのか？

- **🤝 1 つの拠点、4 つのハーネス** — 正規の指示書 (`AGENTS.md`)、共通フック (`utils/harness/hooks.js`)、同期されたロールプロンプトを Claude Code、Codex、Antigravity CLI (`agy`)、DeepSeek Harness (`dsh`) 間で共有し、`pnpm harness sync` で常に同期します。
- **📝 タスクの継続性とクリーンコンテキスト・レビュー (`pnpm task`)** — セッションごとのアクティブタスク管理 (`plan.md`, `state.json`, `NOTES.md`)、ステップ間の依存関係、検証ゲート、独立した 2 ラウンドのレビュー＋トリアージループを備えています。
- **🧠 ローカルの個人メモリとパーソナライゼーション (`pnpm memory`)** — マシンローカルかつ git 管理外のメモリ機能です。コアブロック注入、プロンプト／失敗時の想起、マルチエージェントによるバックグラウンド抽出・統合、エージェントの口調カスタマイズ (`pnpm memory personalize`) に対応しています。
- **🚀 マルチエージェント・オーケストレーション (`pnpm agent`, `pnpm loop`, `pnpm swarm`)** — 別のエージェントにヘッドレスでセカンドオピニオンを求めたり、git worktree 内で無人実行の修正・レビューループを回したり、実行可能なステップをクリーンなコンテキストで複数 worktree に並列展開したりできます。
- **🧩 モジュラーなスキルエコシステム (`skills-lock.json`)** — リポジトリ管理下のワークスペーススキルに加え、ロックファイルで固定された外部スキル（[`shino369/kyoten-skills`](https://github.com/shino369/kyoten-skills) のポータブルスキルを含む）を `pnpm skills:install`、`pnpm skills:check`、`pnpm skills:link` でスマートに管理します。
- **🛡️ 組み込みガードレールと 100% 品質ゲート (`pnpm check`)** — シークレット保護、取り消し可能な削除 (`pnpm task rm`)、サプライチェーン強化、全ハーネス共通の git フック、TypeScript の型チェック、ESLint、Prettier、カバレッジ 100% を閾値とする Vitest を統合しています。

> 📖 すべてのコマンドとフラグを確認したい場合は、自動生成された [CLI リファレンス](docs/cli.md) およびアーキテクチャ全体を解説した [docs/harness.md](docs/harness.md) をご覧ください。

## 📋 動作要件

- **Node.js 24 以降**（`.nvmrc` で 24 を指定。`agent-browser` は 24 以上が必須です）
- **pnpm 12.14.0**（Corepack 経由で `package.json` に固定）— `corepack enable` を実行するか、コマンドの先頭に `corepack pnpm` を付けて実行してください
- **Chrome / Chromium** _（任意）_ — Playwright の E2E テストおよびブラウザ操作スキルで使用します
- **`uv`** _（任意）_ — `browser-use` ランタイムおよび Python 3.12 のスキルスクリプト (`skill-creator`, `transparent-background`) で使用します
- **`gh` CLI** _（任意）_ — GitHub ワークフローおよび PR レビューで使用します

## 🚀 はじめに

```bash
git clone https://github.com/shino369/kyoten.git
cd kyoten
corepack enable
pnpm workspace:setup   # install deps + pinned skills, link skills, enable git hooks, init memory
pnpm workspace:check   # verify setup; every failure prints a Fix command
```

オプションのセットアップフラグ：

- `--with-browsers` — `agent-browser` と Playwright の Chromium をインストールします
- `--skip-skills` — オフライン時に外部スキルのダウンロードをスキップします
- `--target <dir>` — 別のハーネスのスキルフォルダにスキルをリンクします

トラブルシューティングについては `.agents/skills/workspace-setup/SKILL.md` を参照してください。

品質ゲート全体（型チェック、リント、フォーマットチェック、カバレッジ 100% のテスト）を実行します：

```bash
pnpm check
```

あとは、このディレクトリ内でコーディングエージェント（Claude Code、Codex、`agy`、または DSH）を起動するだけです！🎉

## 🗂️ リポジトリ構成

```text
.
├── .agents/
│   ├── agents/              # Generated Antigravity role prompts (pnpm harness sync)
│   ├── hooks.json           # Generated Antigravity hooks config
│   └── skills/              # Skills: project-owned (tracked) + external (git-ignored)
├── .claude/
│   ├── agents/              # Canonical role prompts / subagents
│   ├── hooks/               # Hook entry points (task brief, context monitor, audit, format)
│   ├── rules/               # Path-scoped rules (scripts, tests)
│   ├── skills/              # Links into .agents/skills (generated, git-ignored)
│   └── workflows/           # Saved Claude Code workflows (review, implement-plan, research)
├── .codex/                  # Generated Codex hooks, rules, and role prompts
├── .dsh/                    # Generated DSH hooks and workspace patch overlay
├── .githooks/               # pre-commit + commit-msg (all harnesses)
├── docs/
│   ├── cli.md               # Generated CLI reference (pnpm docs:cli)
│   ├── harness.md           # Full harness architecture & worked examples
│   └── testing/             # Deep testing & mocking guides
├── e2e/                     # Playwright e2e tests
├── tasks/                   # Machine-local task folders (git-ignored)
├── templates/task/          # plan / NOTES / REVIEW / STUDIES templates for pnpm task
├── tools/                   # catalog.json (tracked) + local.json (this machine, git-ignored)
├── utils/                   # Shared Node ESM utilities (task, memory, harness, loop, swarm, agent, tools)
├── AGENTS.md                # Canonical instructions for every agent harness
├── CLAUDE.md                # @AGENTS.md + Claude-Code-only notes
├── skills-lock.json         # Pinned external skills lockfile (skills.sh)
└── ...
```

外部スキルは git にコミットされません。`pnpm skills:install` を実行すると、`skills-lock.json` の推奨セットが `.agents/skills/`（git 管理外）にインストールされるため、自分のマシンに何を導入するかを手元で管理できます。

## 🤖 対応ハーネスとオーケストレーション

| ハーネス                     | 指示ファイル                                             | スキルと連携機能                                                                            |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Claude Code**              | `CLAUDE.md` → `@AGENTS.md`                               | `.claude/skills/` リンク、`.claude/settings.json`、フック、サブエージェント                 |
| **Codex**                    | `AGENTS.md`                                              | `.agents/skills/`（ネイティブ対応）、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` |
| **Antigravity CLI (`agy`)**  | `AGENTS.md`（24,000 バイト以下）                         | `.agents/skills/`（ネイティブ対応）、`.agents/hooks.json`（6 イベント）、`.agents/agents/`  |
| **DeepSeek Harness (`dsh`)** | `AGENTS.md`（`--patch .dsh/workspace.patch.yml` で起動） | `.agents/skills/`、`.dsh/hooks.json`、Claude フックブリッジ _（一部検証済み）_              |

正規のソースファイルから各ハーネス設定を再生成するには `pnpm harness sync` を、設定が一致しているか確認するには `pnpm harness check` を実行します。`.githooks/` 内の git フックはすべてのハーネスに対してフォーマット、リント、Conventional Commits を強制し、`pnpm task status` は `SessionStart` が注入するものと同じ再開ブリーフを出力します。

### 🛠️ ツール管理と他エージェントの呼び出し

`pnpm tools scan` はマシンにインストールされているエージェント、CLI、ランタイムを検出し、`tools/catalog.json` と照合して `tools/local.json`（git 管理外）に保存します。`SessionStart` には 1 行のツールサマリーが含まれるため、各エージェントはどのツールへ委譲できるかを把握できます。

```bash
pnpm tools list --all                                   # see installed tools and install hints
pnpm tools add dsh --kind agent --command "npx -y @deepseek-ai/dsh"
pnpm agent ask --agent codex "Review utils/task/loop.js for edge cases"   # read-only second opinion
pnpm loop my-task --agent codex --max 3                 # unattended fix-until-green in a worktree
pnpm loop my-task --agent codex --review --reviewer claude   # + independent review rounds & fixes
pnpm swarm my-task --agent claude --workers 2           # parallel workers, one worktree per step
```

ヘッドレスで起動されるすべての子プロセスは `MEMORY_EXTRACT=1` 付きで実行され（メモリフックを抑止し、セッションを抽出キューから除外します）、`pnpm loop` および `pnpm swarm` の worktree には `AGENTS.local.md` と `CLAUDE.local.md` を含めないため、レビューや修正は常にクリーンなコンテキストで開始されます。

## 📝 タスク管理とレビューループ

作業中に生成されるファイルは `tasks/<task-name-yymmdd>/` に保存され、`pnpm task` で管理します。これにより、どのエージェントでも（もちろんご自身でも）文脈を失わずに作業を中断、引き継ぎ、再開できます：

```bash
pnpm task new some-task --goal "Translate the X post" --step "Draft" --step "Proofread" --verify "pnpm check"
pnpm task step s1 start            # … work …
pnpm task step s1 done -m "draft in translated/"
pnpm task note --done "drafted" --next "proofread section 2"
pnpm task status                   # resume brief: goal, next step, last note, verify, git
```

```text
tasks/some-task-260101/
├── plan.md                        # goal, acceptance, generated steps, decisions
├── state.json                     # machine state (managed only via pnpm task)
├── NOTES.md                       # append-only progress log
├── reviews/REVIEW_some-task.md    # pnpm task template review
├── studies/STUDIES_some-task.md   # pnpm task template study
└── scripts/ docs/ translated/ tmp/
```

各セッションにはそれぞれ専用のアクティブタスクが紐づきます（新規セッションのデフォルトは `tasks/.active` です）。対応ハーネスでは `SessionStart` 時に再開ブリーフが自動注入され、コードタスクは **計画 → テストファースト実装 → クリーンコンテキスト・レビュー (`pnpm task review`) → 独立トリアージ → 修正**（最大 2 ラウンド）という体系化された品質ループに沿って進みます。詳細は `AGENTS.md` §4 および [docs/harness.md](docs/harness.md) を参照してください。`tasks/` と `logs/` は git 管理外のため、タスクは各マシン固有のプライベートな記録として保持されます。

## 🧠 ローカルの個人メモリとパーソナライゼーション

セッションやハーネスをまたいで、継続的な好み、マシン固有の回避策、リポジトリに関する知見をエージェントが記憶します。データは完全にローカル環境内にとどまります（`memory/`、`AGENTS.local.md`、`CLAUDE.local.md` は git 管理外であり、外部にプッシュされることはありません）：

```bash
pnpm memory init                    # once (pnpm workspace:setup runs it)
pnpm memory                         # status: notes, core block, saving on/off, extraction queue
pnpm memory add "The user prefers design first, then review." --scope user --type preference --tags design,review
pnpm memory recall "how do I merge this PR"   # preview what the hooks would inject
pnpm memory personalize --presets   # set how agents talk to you (chat only, never code/commits)
pnpm memory personalize --language "Japanese"   # keep your reply language even when writing in English
pnpm memory personalize --persona-file persona.md   # load a longer markdown persona
# or edit memory/persona.md directly: pnpm memory init (and workspace:setup) apply your edits
pnpm memory personalize --off       # pause saved response personalization
pnpm memory personalize --on        # resume in new sessions
pnpm memory off --session           # incognito session (no saving)
pnpm memory export                  # checksummed .tar.gz backup; restore via import <file> --dry-run
```

- **マルチエージェントによるバックグラウンドジョブ**：メモリの抽出、週次の統合、ペルソナの圧縮・監査は、デフォルトで**そのセッション自身のエージェント CLI** (`claude`, `codex`, `dsh`, `agy`) で実行されます。`pnpm memory set --extract-agent <agent>` で任意の CLI を指定することも可能です。
- **ツール無効化の分離環境**：メモリジョブはツールを無効化した空の一時フォルダ内で実行されます。Codex は MCP サーバーが未設定であればそのまま動作します（Codex の MCP サーバーを設定している場合はフェイルクローズで安全に停止し、`--extract-agent` を切り替えるための `Fix:` コマンドを表示します）。また、Claude および Codex の分離フラグではダブルクォートを避けることで、Windows の `.cmd` シムでも問題なく動作するようにしています。
- **保存の一時停止**：`pnpm memory off` を実行すると、自動抽出と週次統合の両方が一時停止します（手動での `pnpm memory consolidate` は `--force` を指定しない限り拒否されますが、`--dry-run` は常に実行できます）。

メモリライフサイクルの詳細は `AGENTS.md` §13 および [docs/harness.md](docs/harness.md) を参照してください。

## 🧩 スキル

### 🏠 プロジェクト固有スキル

| スキル            | 概要                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `workspace-setup` | このワークスペースの初期化・修復（依存関係、スキル、リンク、フック、メモリ）。 |
| `context-manager` | コンテキストモニターと連携したコンテキスト劣化の防止・回復。                   |
| `web-browsing`    | Web 操作、実ブラウザセッション、E2E テストにおけるツール選定とワークフロー。   |

### 📦 外部スキル (`skills-lock.json`)

外部スキルはコミットされません。`pnpm skills:install` で推奨セットをインストールすると、各スキルは git 管理外の `.agents/skills/` にローカル配置されます。取得元とハッシュは `skills-lock.json` に固定されており、各リポジトリ独自のライセンスが適用されます。

#### ✨ Kyoten Skills ([shino369/kyoten-skills](https://github.com/shino369/kyoten-skills), MIT)

| スキル                   | 概要                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `dependency-update`      | `analyze_deps.mjs` を使った Dependabot 形式の pnpm 依存関係アップデート。            |
| `security-update`        | リリース経過日数チェック付きの CVE・監査パッチ適用。                                 |
| `transparent-background` | 単色背景画像をきれいなエッジの透過 PNG に変換（残存ピクセル除去・再着色にも対応）。  |
| `translation-expertise`  | EN ↔ JA ↔ zh-TW のハウススタイル、1:1 構造一致、台湾華語・日本語の用語トラップ対策。 |

#### 🌐 ブラウザ・Web

| スキル           | 概要                                                                                             | 取得元                                                                    | クレジット  |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------- |
| `agent-browser`  | ブラウザ自動化 CLI（ページ遷移、フォーム入力、スクリーンショット、スクレイピング、アプリ検証）。 | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Vercel Labs |
| `browser-use`    | CDP 経由の直接ブラウザ制御（自動化、スクレイピング、スクリーンショット）。                       | [browser-use/browser-use](https://github.com/browser-use/browser-use)     | Browser Use |
| `playwright-cli` | Playwright によるブラウザ自動化と E2E テストワークフロー。                                       | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)   | Microsoft   |

> ブラウザツールの使い分けは `AGENTS.md` §8 で定義しています。アドホックな操作は `agent-browser` を標準とし、自律操作・Python・実 Chrome・クラウド実行は `browser-use`、Playwright は E2E テスト専用としています。

#### 🛠️ エンジニアリング・ワークフロー

| スキル            | 概要                                                                  | 取得元                                                    | クレジット  |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| `code-review`     | 並列サブエージェントによる 2 軸レビュー（リポジトリ規約＋元の仕様）。 | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `diagnosing-bugs` | 難解なバグやパフォーマンス劣化のための体系的な診断ループ。            | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `tdd`             | レッド・グリーン・リファクタによるテスト駆動開発。                    | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |

#### 🎨 メタ・ツール

| スキル          | 概要                                                   | 取得元                                                    | クレジット |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------- | ---------- |
| `skill-creator` | エージェントスキルの作成、編集、ベンチマーク、最適化。 | [anthropics/skills](https://github.com/anthropics/skills) | Anthropic  |

個人的または任意で使うスキル（例：`i-have-adhd`）は推奨ロックファイルには含まれていません。必要な場合は `pnpm dlx skills add ayghri/i-have-adhd --skill i-have-adhd --copy --agent claude-code` で個別にインストールしてください。

> サードパーティ製スキルはすべて元のアップストリームライセンスに従います。インストールされたコピーにはライセンスファイルが含まれません（例外として `skill-creator` には `.agents/skills/skill-creator/LICENSE.txt` が同梱されます）。その他のスキルについては上記の取得元リポジトリをご確認ください。

### ⚙️ スキルの管理

プロジェクト固有スキルは `.agents/skills/` に配置され、このリポジトリにコミットされます。新しく追加する場合は、`.agents/skills/workspace-setup/SKILL.md` の「Adding a project-owned skill」の手順に従ってください。

外部スキルは**コミットされません**。Vercel の [`skills` CLI](https://github.com/vercel-labs/skills)（[skills.sh](https://skills.sh) エコシステム）を使って、`skills-lock.json` から推奨セットをインストールします：

```bash
pnpm skills:install                      # install everything in skills-lock.json
pnpm skills:install --skip <name>        # skip optional skills
pnpm skills:install --only <name>        # install only the named skills (comma-separated)
pnpm skills:update                       # update installed skills
pnpm skills:check                        # verify lock entries are installed
pnpm skills:link                         # (re)link .agents/skills into .claude/skills
```

インストールには skills.sh のデフォルトレイアウト (`--agent claude-code codex`) を使用します。実ファイルは `.agents/skills/<name>/`（Codex と Antigravity がネイティブに参照）に配置され、`.claude/skills/<name>` にはそこへの相対シンボリックリンクが作成されます。`skills:link` はプロジェクト固有スキルにも同様のリンクを作成し、旧来のコピー方式からの移行、不要リンクの削除を行い、Windows ではディレクトリジャンクションへフォールバックします。外部スキルは git の追跡対象外のままにし、`skills-lock.json` に変更があった場合は同ファイルをコミットしてください。`skills:check` は、ロック内のすべてのエントリがインストールされており、それぞれのフロントマター名と一致しているかを検証します。

ロックファイル内のハッシュは取得元スナップショットのハッシュであり、インストール済みコピーからは再現できないため、内容の変更は `git diff` で確認してください。Windows では、アップストリームのクラッシュにより `skills:update` が更新成功後に終了コード 127 で終了する場合があります。失敗と判断する前にファイルが更新されているか確認してください。

手動でスキルを追加するには、`pnpm dlx skills add <owner/repo> --skill <name> --agent claude-code codex -y` を実行してから `pnpm skills:link` を実行します。追加されたスキルはローカルかつ未追跡のまま維持されます。

### 🔧 スキルのランタイム要件

ほとんどのスキルは指示ファイルのみで構成されますが、以下のスキルにはローカルランタイムが必要です：

| スキル                   | ランタイム                         | 確認・インストール方法                                                                                                                       |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-browser`          | `agent-browser` CLI                | `pnpm exec agent-browser --version`。初回に `pnpm exec agent-browser install` を実行後、`pnpm exec agent-browser ...` を使用 (devDependency) |
| `browser-use`            | `browser-use` CLI                  | `browser-use --version`。`uv tool install --python 3.12 browser-use` でインストール                                                          |
| `playwright-cli`         | ローカル Playwright                | `pnpm exec playwright --version`。`pnpm exec playwright cli ...` で実行                                                                      |
| `skill-creator`          | Python 3.12 + PyYAML               | スキルディレクトリから `uv run --with pyyaml --python 3.12 python ...` を実行                                                                |
| `transparent-background` | Python 3.12 + Pillow, NumPy, SciPy | `uv run --python 3.12 --with pillow --with numpy --with scipy python -I .agents/skills/transparent-background/scripts/imgalpha.py --help`    |
| `dependency-update`      | `gh` CLI                           | `gh --version`。<https://cli.github.com/> からインストール（PR への添付にも使用）                                                            |
| Playwright E2E           | Chromium                           | `pnpm exec playwright install chromium`                                                                                                      |

このワークスペースでは `npm` コマンドがブロックされています。単発の CLI には `pnpm dlx`、プロジェクトローカルのバイナリには `pnpm add -D` と `pnpm exec`、Python CLI には `uv tool` または `uvx` を使用してください。グローバルインストールはワークスペースのロックファイルとサプライチェーン設定をバイパスしてしまうため、`pnpm add -g` は使用しないでください。

`browser-use` スキルは [browser-use/browser-use](https://github.com/browser-use/browser-use) から提供されており、対応する `browser-use` CLI（固定バージョンの依存関係として `browser-harness` を導入）が必要です。`agent-browser` スキルはグローバルシムがインストールされないため、`pnpm exec agent-browser ...` 経由で呼び出します。

ローカルの Chrome にアタッチするブラウザスキルには CDP エンドポイントが必要です。`chrome://inspect/#remote-debugging` を有効にするか、`--remote-debugging-port=9222 --user-data-dir=<profile>` を付けて分離プロファイルで Chrome を起動し、`browser-use` 用に `BU_CDP_URL=http://127.0.0.1:9222` を設定してください。

## 🎭 エージェントとルール

### ロールプロンプト (`.claude/agents/`)

正規のロールプロンプトは `.claude/agents/*.md` に配置され、`pnpm harness sync` によって `.codex/agents/*.toml` および `.agents/agents/*.md` へ同期されます：

| エージェント            | 役割                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `planner`               | ゴールを依存関係付きの小さく検証可能なステップへ分解 (`pnpm task`)。              |
| `verifier`              | 独立した PASS/FAIL 判定（検証の実行、受け入れ基準・テストの確認）。               |
| `reviewer`              | ブリーフのみを用いたクリーンコンテキスト・レビューとトリアージ向け指摘の作成。    |
| `security-reviewer`     | セキュリティ特化レビュー（認証、インジェクション、XSS、シークレット、依存関係）。 |
| `test-runner`           | テストの実行および失敗箇所・カバレッジの報告。                                    |
| `trilingual-translator` | EN / JA / zh-TW の 3 言語翻訳（初訳・校正・仕上げの各ロールに対応）。             |

### パス限定ルール (`.claude/rules/`)

常時適用するガイドラインは、すべてのハーネスが参照できるよう `AGENTS.md` に記述しています。`.claude/rules/` にはパス限定のルールを配置しており、Claude Code が自動で読み込むほか、他のエージェントも `AGENTS.md` の指示に従って参照します：

| ルール                | 適用範囲       | 目的                                               |
| --------------------- | -------------- | -------------------------------------------------- |
| `testing`             | テストファイル | Vitest、カバレッジ 100%、モックの方針。            |
| `working-with-script` | スクリプト     | Node.js 優先のスクリプト設計、エラー処理、テスト。 |

## 🪝 フック

共通のフックロジックは `utils/harness/hooks.js` と `.claude/hooks/` に配置されており、`pnpm harness sync` を通じて Claude Code、Codex、Antigravity CLI、DSH に組み込まれます：

| フック                 | イベント                                                                             | 目的                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `session_start.js`     | `SessionStart`                                                                       | アクティブタスクの再開ブリーフと利用可能なツールサマリーを注入。             |
| `pre_compact.js`       | `PreCompact`                                                                         | タスクの `NOTES.md` にチェックポイントを追記。                               |
| `task_loop.js`         | `Stop`, `UserPromptSubmit`                                                           | インナーループ（検証を実行し、クリーンコンテキスト・レビューループへ誘導）。 |
| `context_monitor.js`   | `UserPromptSubmit`                                                                   | コンテキストウィンドウ使用率が 20% / 40% / 60% に達した際に警告。            |
| `audit_logger.js`      | `PostToolUse` (`*`)                                                                  | ツール使用履歴を `logs/<YYYYMMDD>/logging.jsonl` に記録。                    |
| `auto_format.js`       | `PostToolUse` (`Edit\|Write`)                                                        | 編集したファイルに Prettier を自動実行。                                     |
| `guard.js`             | `PreToolUse`                                                                         | シークレットアクセス、`rm`、`npm`、破壊的な git コマンドをブロック。         |
| `utils/memory/hook.js` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `SessionEnd` | メモリのコアブロック注入、プロンプト／失敗時の想起、通知、抽出。             |

コンテキストモニターのデフォルトは 1M トークンウィンドウです。変更する場合は `CLAUDE_CONTEXT_WINDOW` を設定してください。

## 🌍 翻訳

エージェントに翻訳を依頼するか、`trilingual-translator` サブエージェントを呼び出してください。`translation-expertise` スキルにより、ハウススタイル、1:1 の構造一致ルール、日本語・台湾華語 (zh-TW) の用語トラップ対策が適用されます：

- 英語 ↔ 日本語（`日本語`）↔ 繁体字中国語（`繁體中文`、台湾標準がデフォルト）
- 任意の 3 段階ワークフロー（**初訳 → 校正 → 仕上げ**）に対応し、下書きはタスク内の `translated/` フォルダへ出力
- ファイルおよび URL ソースに対応：静的ページにはフェッチツール、JS を多用するページには `agent-browser` または `browser-use` を使用（Playwright は E2E テスト専用）

## 🧪 テスト

ユニットテストおよび統合テストには **Vitest** を使用しており、`utils/`、`.claude/hooks/`、およびプロジェクト固有の `.agents/skills/` に対して **カバレッジ 100% の閾値** を設定しています：

```bash
pnpm test
pnpm test:coverage   # 100% statements, branches, functions, lines
```

テスト規約は `.claude/rules/testing.md` に、より詳しいガイドは `docs/testing/` にまとめています。

E2E テストには `e2e/` 配下の **Playwright** を使用します（`*.e2e.*` テストが追加されるまでは、空のスイートとして正常終了します）：

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

## 🛡️ セキュリティと設定

### 📦 パッケージ管理

pnpm **12.14.0** は `packageManager` で固定されており、`engines.pnpm` および `engineStrict` によって強制されます。すべての開発依存パッケージは `dev` カタログで管理します：

```bash
pnpm add -D some-package --save-catalog-name=dev
```

`pnpm-workspace.yaml` におけるサプライチェーン強化設定：

- `minimumReleaseAge: 10080` — 新しいパッケージバージョンを採用する前に 7 日間の待機期間を設けます
- `strictPeerDependencies: true`
- `engineStrict: true`
- `ignoreScripts: true` と明示的な `allowBuilds` (`esbuild: true`, `agent-browser: false`)
- `trustPolicy: no-downgrade`

### 🔐 権限とガードレール

ワークスペースの権限は `.claude/settings.json` で設定され、`utils/harness/hooks.js` によって各ハーネスへ反映されます：

- **許可される操作**：`pnpm` コマンド（取り消し可能な `pnpm task rm` を含む）、ローカルの git 操作 (`status`, `diff`, `log`, `add`, `commit`, `switch -c`, `checkout -b`, `rev-parse`, `show`)、リポジトリ内スクリプト (`utils/`, `.claude/hooks/`, `.agents/skills/`) に限定した `node` 実行、および基本的なディレクトリ確認 (`ls`, `dir`, `cd`, `pwd`, `echo`, `type`, `mkdir`)。任意の `python`、`node`、`cat`、`curl` は事前許可されていません。
- **確認が必要な操作**：`git push`、`rebase`、`merge`、`cherry-pick`、および強制終了シグナル (`kill -9`, `pkill`, `killall`)。
- **禁止される操作**：シークレットファイル (`.env*`, `secrets/`, `*.pem`, `*.key`, `credentials.json`, `~/.ssh/`, `~/.aws/`) へのアクセス、`rm`（代わりに `pnpm task rm` を使用してください。ファイルを 7 日間 `tasks/.trash/` へ退避します）、`npm`、`sudo` や管理者コマンド、破壊的な git 操作 (`force push`, `reset --hard`, `clean -fd`, `branch -D`, `tag -d`)、および `pnpm publish`。

マシン固有の上書き設定は `.claude/settings.local.json`（git 管理外）に記述してください。

### 🔌 MCP サーバー

ローカルの MCP 設定は `.mcp.json`（git 管理外）に配置します。`.mcp.json.example` をコピーし、お使いのマシンに合わせてパスを調整してください。

## 🤝 コントリビューション

個人用のワークスペースではありますが、フォーク、アイデア、改善提案はいつでも歓迎します！PR を作成する前に、`pnpm check` がパスすることを確認してください。

外部スキルは skills.sh (`skills-lock.json`) で管理されており、プロジェクト固有スキルは `.agents/skills/` に配置されています。

## 💖 クレジット

- **外部スキル**：[skills.sh](https://skills.sh) エコシステムを利用し、[vercel-labs/skills](https://github.com/vercel-labs/skills) でインストールしています。個別の作者は上記の表に記載しています。
- **対応ハーネス**：[Claude Code](https://claude.com/claude-code)、[Codex](https://openai.com/codex/)、[Antigravity CLI](https://antigravity.google/docs/cli/reference)、および [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 📄 ライセンス

このリポジトリのオリジナルコンテンツは [ISC](./LICENSE) ライセンスのもとで公開されています。外部スキルはこのリポジトリには含まれておらず、インストール後も元のアップストリームライセンスが適用されます。
