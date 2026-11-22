# Kyoten

![Kyoten](./docs/images/kyoten-logo.png)

> **專屬於你的 AI 程式開發代理據點**——涵蓋程式設計、文件撰寫、研究、翻譯與生成式 AI 工作的共用工作區。✨

[![Test CI](https://github.com/shino369/kyoten/actions/workflows/test.yml/badge.svg)](https://github.com/shino369/kyoten/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

🌐 [English](./README.md) · [日本語](./README.ja.md) · **繁體中文**

---

**Kyoten**（_拠点_，日語意為「據點」或「作戰基地」）將你所有的 AI 代理設定整合到單一乾淨、可攜的儲存庫中。你不需要在每個工具間重複設定規則、Hooks、技能與記憶，只需設定一次據點，就能無縫搭配 **Claude Code**、**Codex**、**Antigravity CLI（`agy`）** 與 **DeepSeek Harness（`dsh`）** 運作。

所有工具皆以純 Node.js ESM 執行，零執行期相依套件、不需要 Monorepo、也沒有建置步驟——只需 clone 下來、執行一次初始化設定，就能在工作區內啟動你偏好的程式開發代理。🌿

## ✨ 為什麼選擇 Kyoten？

- **🤝 單一據點，四大代理環境**——提供標準指令（`AGENTS.md`）、共用 Hooks（`utils/harness/hooks.js`）與角色提示詞，並透過 `pnpm harness sync` 在 Claude Code、Codex、Antigravity CLI（`agy`）與 DeepSeek Harness（`dsh`）之間保持同步。
- **📝 任務延續與乾淨脈絡審查（`pnpm task`）**——各工作階段獨立追蹤使用中任務（`plan.md`、`state.json`、`NOTES.md`），支援步驟相依性、驗證關卡，以及獨立的 2 輪審查與分流覆核循環。
- **🧠 本機個人記憶與個人化設定（`pnpm memory`）**——僅存於本機且由 Git 忽略的記憶系統，支援核心區塊注入、提示詞／失敗喚回、多代理背景擷取與彙整，以及可自訂的代理語氣（`pnpm memory personalize`）。
- **🚀 多代理協作（`pnpm agent`、`pnpm loop`、`pnpm swarm`）**——以非互動模式向其他代理徵詢第二意見、在 Git worktree 中執行全自動修正與審查循環，或在多個 worktree 中以乾淨脈絡平行處理已就緒的步驟。
- **🧩 模組化技能生態系（`skills-lock.json`）**——整合受追蹤的工作區自建技能與鎖定版本的外部技能（包含來自 [`shino369/kyoten-skills`](https://github.com/shino369/kyoten-skills) 的可攜式技能），透過 `pnpm skills:install`、`pnpm skills:check` 與 `pnpm skills:link` 俐落管理。
- **🛡️ 內建安全護欄與品質把關（`pnpm check`）**——涵蓋機密防護、可復原刪除（`pnpm task rm`）、供應鏈安全強化、跨代理環境 Git Hooks、TypeScript 型別檢查、ESLint、Prettier，以及採用 95% 涵蓋率門檻的 Vitest。

> 📖 想查詢所有指令與參數旗標？請參閱自動產生的 [CLI 參考手冊](docs/cli.md)，以及 [docs/harness.md](docs/harness.md) 中的完整架構說明。

## 📋 系統需求

- **Node.js 24 或更新版本**（`.nvmrc` 鎖定為 24；`agent-browser` 需要 24+）
- **pnpm 12.14.0**，透過 Corepack 鎖定於 `package.json`——執行 `corepack enable`，或在指令前加上 `corepack pnpm`
- **Chrome / Chromium**（_選用_）——用於 Playwright e2e 測試與瀏覽器操控技能
- **`uv`**（_選用_）——用於 `browser-use` 執行環境與 Python 3.12 技能腳本（`skill-creator`、`transparent-background`）
- **`gh` CLI**（_選用_）——用於 GitHub 工作流程與 PR 審查

## 🚀 快速開始

```bash
git clone https://github.com/shino369/kyoten.git
cd kyoten
corepack enable
pnpm workspace:setup   # install deps + pinned skills, link skills, enable git hooks, init memory
pnpm workspace:check   # verify setup; every failure prints a Fix command
```

選用的設定參數：

- `--with-browsers`——安裝 `agent-browser` 與 Playwright Chromium
- `--skip-skills`——離線時略過外部技能下載
- `--target <dir>`——將技能連結至其他代理環境的技能資料夾

疑難排解請參閱 `.agents/skills/workspace-setup/SKILL.md`。

執行完整品質把關（型別檢查、Lint、格式檢查，以及會統計涵蓋率的測試）。

```bash
pnpm check
```

接著只要在此目錄中啟動你的程式開發代理（Claude Code、Codex、`agy` 或 DSH）即可！🎉

## 🗂️ 儲存庫目錄結構

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

外部技能不會提交至 Git。`pnpm skills:install` 會依據 `skills-lock.json` 將推薦組合安裝至 `.agents/skills/`（由 Git 忽略），讓你完全掌控本機所安裝的內容。

## 🤖 支援的代理環境與多代理協作

| 代理環境（Harness）           | 指令設定                                                     | 技能與整合                                                                            |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Claude Code**               | `CLAUDE.md` → `@AGENTS.md`                                   | `.claude/skills/` 連結、`.claude/settings.json`、Hooks、子代理                        |
| **Codex**                     | `AGENTS.md`                                                  | `.agents/skills/`（原生支援）、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` |
| **Antigravity CLI（`agy`）**  | `AGENTS.md`（≤ 24,000 位元組）                               | `.agents/skills/`（原生支援）、`.agents/hooks.json`（6 種事件）、`.agents/agents/`    |
| **DeepSeek Harness（`dsh`）** | `AGENTS.md`（啟動時加上 `--patch .dsh/workspace.patch.yml`） | `.agents/skills/`、`.dsh/hooks.json`、Claude Hooks 橋接（_僅部分測試_）               |

執行 `pnpm harness sync` 可從標準來源重新產生各代理環境設定檔，執行 `pnpm harness check` 則可驗證設定是否一致。`.githooks/` 中的 Git Hooks 會為所有代理環境強制執行格式化、Lint 與 Conventional Commits 規範，而 `pnpm task status` 輸出的續接摘要也與 `SessionStart` 自動注入的內容完全相同。

### 🛠️ 工具管理與呼叫其他代理

`pnpm tools scan` 會偵測本機已安裝的代理、CLI 與執行環境，並對照 `tools/catalog.json` 儲存至 `tools/local.json`（由 Git 忽略）。`SessionStart` 會附上一行工具摘要，讓每個代理都知道可以委派給哪些工具。

```bash
pnpm tools list --all                                   # see installed tools and install hints
pnpm tools add dsh --kind agent --command "npx -y @deepseek-ai/dsh"
pnpm agent ask --agent codex "Review utils/task/loop.js for edge cases"   # read-only second opinion
pnpm loop my-task --agent codex --max 3                 # unattended fix-until-green in a worktree
pnpm loop my-task --agent codex --review --reviewer claude   # + independent review rounds & fixes
pnpm swarm my-task --agent claude --workers 2           # parallel workers, one worktree per step
```

每個非互動子處理程序在執行時都會設定 `MEMORY_EXTRACT=1`（使記憶 Hooks 不主動輸出，且工作階段不會進入擷取佇列），而 `pnpm loop` 與 `pnpm swarm` 的 worktree 會排除 `AGENTS.local.md` 與 `CLAUDE.local.md`，確保審查與修正一律從乾淨脈絡開始。

## 📝 任務管理與審查循環

產出的工作成果皆存放於 `tasks/<task-name-yymmdd>/`，並透過 `pnpm task` 統一管理，無論是代理還是你自己，都能隨時暫停、交接與續接而不遺失脈絡：

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

每個工作階段都會綁定各自的使用中任務（新工作階段預設採用 `tasks/.active`）。`SessionStart` 會在支援的代理環境中自動注入續接摘要，程式碼任務則依循結構化的品質循環：**規劃 → 測試優先實作 → 乾淨脈絡審查（`pnpm task review`）→ 獨立分流覆核 → 修正**（最多 2 輪）。完整說明請參閱 `AGENTS.md` §4 與 [docs/harness.md](docs/harness.md)。`tasks/` 與 `logs/` 皆由 Git 忽略——任務內容僅保留於各自電腦的本機環境中。

## 🧠 本機個人記憶與個人化設定

讓代理跨工作階段與代理環境記住長期偏好、本機變通做法與儲存庫事實——僅存於你的本機（`memory/`、`AGENTS.local.md` 與 `CLAUDE.local.md` 皆由 Git 忽略，絕不會推送出去）：

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

- **多代理背景作業**：擷取、每週彙整，以及角色設定精簡／稽核作業預設會使用**該工作階段所屬的代理 CLI**（`claude`、`codex`、`dsh` 或 `agy`）執行——也可透過 `pnpm memory set --extract-agent <agent>` 指定固定使用的 CLI。
- **零工具隔離**：記憶作業會在停用工具的空白暫存資料夾中執行。Codex 在未設定任何 MCP 伺服器時可直接使用（若你有設定 Codex MCP 伺服器，系統會基於安全考量直接中止並顯示 `Fix:` 指令，引導你切換 `--extract-agent`）；Claude 與 Codex 的隔離參數均避免使用雙引號，確保 Windows `.cmd` shim 運作正常。
- **暫停儲存**：執行 `pnpm memory off` 會同時暫停擷取與每週彙整（手動執行 `pnpm memory consolidate` 時除非加上 `--force`，否則會拒絕執行；`--dry-run` 則隨時可用）。

完整的記憶生命週期說明請參閱 `AGENTS.md` §13 與 [docs/harness.md](docs/harness.md)。

## 🧩 技能（Skills）

### 🏠 專案自建技能

| 技能              | 功能說明                                                      |
| ----------------- | ------------------------------------------------------------- |
| `workspace-setup` | 初始化或修復本工作區（相依套件、技能、連結、Hooks、記憶）。   |
| `context-manager` | 搭配脈絡監控器，預防脈絡品質退化並協助恢復。                  |
| `web-browsing`    | 網頁互動、真實瀏覽器工作階段與 e2e 測試的工具選擇與工作流程。 |

### 📦 外部技能（`skills-lock.json`）

外部技能不會提交至 Git。執行 `pnpm skills:install` 即可安裝推薦組合；每項技能皆會安裝至本機且由 Git 忽略的 `.agents/skills/` 目錄。來源與雜湊值皆鎖定於 `skills-lock.json`，各上游儲存庫均適用其各自的授權條款。

#### ✨ Kyoten Skills（[shino369/kyoten-skills](https://github.com/shino369/kyoten-skills)，MIT）

| 技能                     | 功能說明                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `dependency-update`      | 搭配 `analyze_deps.mjs` 進行仿 Dependabot 風格的 pnpm 相依套件更新。     |
| `security-update`        | 結合發布天數檢查進行 CVE 與稽核漏洞修補。                                |
| `transparent-background` | 將純色背景圖片轉為邊緣乾淨的透明 PNG，並支援清理殘留雜點與局部換色。     |
| `translation-expertise`  | EN ↔ JA ↔ zh-TW 譯文風格規範、1:1 結構對齊，以及台灣／日文術語陷阱防護。 |

#### 🌐 瀏覽器與網頁

| 技能             | 功能說明                                                             | 來源                                                                      | 作者／團隊  |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------- |
| `agent-browser`  | 瀏覽器自動化 CLI：網頁導覽、表單填寫、截圖、資料擷取與應用程式測試。 | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Vercel Labs |
| `browser-use`    | 透過 CDP 直接控制瀏覽器：自動化操作、資料擷取與截圖。                | [browser-use/browser-use](https://github.com/browser-use/browser-use)     | Browser Use |
| `playwright-cli` | Playwright 瀏覽器自動化與 e2e 測試工作流程。                         | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)   | Microsoft   |

> 瀏覽器工具的選用原則定義於 `AGENTS.md` §8：日常臨時互動操作預設使用 `agent-browser`，自主操作／Python／本機真實 Chrome／雲端瀏覽作業使用 `browser-use`，而 Playwright 則專用於 e2e 測試。

#### 🛠️ 工程開發流程

| 技能              | 功能說明                                                     | 來源                                                      | 作者／團隊  |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ----------- |
| `code-review`     | 透過平行子代理進行雙軸審查（儲存庫標準＋原始規格）。         | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `diagnosing-bugs` | 針對棘手錯誤與效能退化的結構化診斷循環。                     | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `tdd`             | 採用紅燈 → 綠燈 → 重構（red-green-refactor）的測試驅動開發。 | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |

#### 🎨 輔助與開發工具

| 技能            | 功能說明                           | 來源                                                      | 作者／團隊 |
| --------------- | ---------------------------------- | --------------------------------------------------------- | ---------- |
| `skill-creator` | 建立、編輯、評測並最佳化代理技能。 | [anthropics/skills](https://github.com/anthropics/skills) | Anthropic  |

個人或選用技能（例如 `i-have-adhd`）不包含在推薦鎖定清單中，可使用 `pnpm dlx skills add ayghri/i-have-adhd --skill i-have-adhd --copy --agent claude-code` 個別安裝。

> 所有第三方技能皆維持其各自的上游授權條款。除了 `skill-creator` 在 `.agents/skills/skill-creator/LICENSE.txt` 隨附 `LICENSE.txt` 之外，其餘已安裝的複本均不含授權檔案；請參閱上述來源儲存庫以確認授權內容。

### ⚙️ 管理技能

專案自建技能存放於 `.agents/skills/` 並提交至本儲存庫。若要新增自建技能，請參閱 `.agents/skills/workspace-setup/SKILL.md` 中的「Adding a project-owned skill」章節。

外部技能**不會提交至 Git**。請使用 Vercel 的 [`skills` CLI](https://github.com/vercel-labs/skills)（[skills.sh](https://skills.sh) 生態系）從 `skills-lock.json` 安裝推薦組合：

```bash
pnpm skills:install                      # install everything in skills-lock.json
pnpm skills:install --skip <name>        # skip optional skills
pnpm skills:install --only <name>        # install only the named skills (comma-separated)
pnpm skills:update                       # update installed skills
pnpm skills:check                        # verify lock entries are installed
pnpm skills:link                         # (re)link .agents/skills into .claude/skills
```

安裝作業採用 skills.sh 搭配 `--agent claude-code codex` 的預設配置：實際檔案會安裝至 `.agents/skills/<name>/`（由 Codex 與 Antigravity 原生讀取），並在 `.claude/skills/<name>` 建立指向該處的相對符號連結。`skills:link` 會為專案自建技能建立相同的連結、遷移舊版複製安裝的檔案、清除過時連結，並在 Windows 上自動改用目錄連接點（Directory Junction）。外部安裝的技能會保持未追蹤狀態；每當 `skills-lock.json` 有異動時請記得提交。`skills:check` 會驗證鎖定檔中的每個項目是否皆已安裝，且 frontmatter 名稱相符。

鎖定檔中的雜湊值是來源快照雜湊值，無法從本機安裝的複本重現，因此請透過 `git diff` 檢視內容變更。在 Windows 上，`skills:update` 可能會在成功更新後因上游工具異常中斷而回傳結束碼 127——判定失敗前請先確認檔案是否已更新。

若要手動新增技能，請執行 `pnpm dlx skills add <owner/repo> --skill <name> --agent claude-code codex -y`，接著執行 `pnpm skills:link`；該技能將僅留存於本機且不納入追蹤。

### 🔧 技能執行環境需求

多數技能僅包含操作指引，以下技能則需要本機執行環境：

| 技能                     | 執行環境                           | 檢查／安裝方式                                                                                                                            |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-browser`          | `agent-browser` CLI                | `pnpm exec agent-browser --version`；先執行一次 `pnpm exec agent-browser install`，之後使用 `pnpm exec agent-browser ...`（開發相依套件） |
| `browser-use`            | `browser-use` CLI                  | `browser-use --version`；透過 `uv tool install --python 3.12 browser-use` 安裝                                                            |
| `playwright-cli`         | 本機 Playwright                    | `pnpm exec playwright --version`；執行 `pnpm exec playwright cli ...`                                                                     |
| `skill-creator`          | Python 3.12 + PyYAML               | 於技能目錄內執行 `uv run --with pyyaml --python 3.12 python ...`                                                                          |
| `transparent-background` | Python 3.12 + Pillow、NumPy、SciPy | `uv run --python 3.12 --with pillow --with numpy --with scipy python -I .agents/skills/transparent-background/scripts/imgalpha.py --help` |
| `dependency-update`      | `gh` CLI                           | `gh --version`；請至 <https://cli.github.com/> 安裝（亦用於 PR 附件處理）                                                                 |
| Playwright e2e           | Chromium                           | `pnpm exec playwright install chromium`                                                                                                   |

本工作區已封鎖 `npm` 指令。單次執行的 CLI 請使用 `pnpm dlx`，專案本機執行檔請使用 `pnpm add -D` 搭配 `pnpm exec`，Python CLI 則使用 `uv tool`／`uvx`。請避免使用 `pnpm add -g`：全域安裝會繞過工作區的鎖定檔與供應鏈安全設定。

`browser-use` 技能來自 [browser-use/browser-use](https://github.com/browser-use/browser-use)，需要其 `browser-use` CLI（會一併安裝鎖定版本的 `browser-harness` 相依套件）。由於未安裝全域 shim，`agent-browser` 技能須透過 `pnpm exec agent-browser ...` 呼叫。

需要連結至本機 Chrome 的瀏覽器技能必須使用其 CDP 端點：你可以啟用 `chrome://inspect/#remote-debugging`，或使用 `--remote-debugging-port=9222 --user-data-dir=<profile>` 啟動獨立的 Chrome 執行個體，並為 `browser-use` 設定 `BU_CDP_URL=http://127.0.0.1:9222`。

## 🎭 代理角色與規則

### 角色提示詞（`.claude/agents/`）

標準角色提示詞存放於 `.claude/agents/*.md`，並透過 `pnpm harness sync` 同步至 `.codex/agents/*.toml` 與 `.agents/agents/*.md`：

| 代理                    | 用途                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `planner`               | 將目標拆解為細小、可驗證且具相依順序的步驟（`pnpm task`）。       |
| `verifier`              | 獨立判定 PASS/FAIL：執行驗證、檢查驗收條件與測試。                |
| `reviewer`              | 僅依審查簡報進行乾淨脈絡審查，整理審查發現以供分流覆核。          |
| `security-reviewer`     | 專注於安全性的審查：身分驗證、注入攻擊、XSS、機密資訊與相依套件。 |
| `test-runner`           | 執行測試並回報失敗項目與涵蓋率。                                  |
| `trilingual-translator` | 擔任初譯、校對與潤飾角色，執行 EN／JA／zh-TW 三語翻譯。           |

### 路徑範圍規則（`.claude/rules/`）

常駐指引皆寫在 `AGENTS.md` 中，讓每個代理環境都能讀取。`.claude/rules/` 則存放路徑範圍規則，由 Claude Code 自動載入，並由 `AGENTS.md` 引導其他代理主動閱讀：

| 規則                  | 適用範圍 | 用途                                      |
| --------------------- | -------- | ----------------------------------------- |
| `testing`             | 測試檔案 | Vitest、95% 涵蓋率門檻、模擬（Mocking）。 |
| `working-with-script` | 腳本檔案 | Node 優先腳本、錯誤處理、測試規範。       |

## 🪝 Hooks

<p align="center">
  <img src="./docs/images/kyoten-hooks.png" alt="笑著說明 Stop Hook 與背景 vitest --coverage 發生鎖定衝突的角色" width="400" />
</p>

共用 Hook 邏輯位於 `utils/harness/hooks.js` 與 `.claude/hooks/`，透過 `pnpm harness sync` 串接至 Claude Code、Codex、Antigravity CLI 與 DSH：

| Hook                   | 事件                                                                                 | 用途                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `session_start.js`     | `SessionStart`                                                                       | 注入使用中任務的續接摘要與可用工具摘要。             |
| `pre_compact.js`       | `PreCompact`                                                                         | 在任務的 `NOTES.md` 中附加檢查點紀錄。               |
| `task_loop.js`         | `Stop`, `UserPromptSubmit`                                                           | 內部循環：執行驗證，接著引導進入乾淨脈絡審查循環。   |
| `context_monitor.js`   | `UserPromptSubmit`                                                                   | 當脈絡視窗使用量達到 20%／40%／60% 時發出警告。      |
| `audit_logger.js`      | `PostToolUse` (`*`)                                                                  | 將工具使用紀錄寫入 `logs/<YYYYMMDD>/logging.jsonl`。 |
| `auto_format.js`       | `PostToolUse` (`Edit\|Write`)                                                        | 對編輯過的檔案自動執行 Prettier。                    |
| `guard.js`             | `PreToolUse`                                                                         | 封鎖機密檔案存取、`rm`、`npm` 與破壞性 Git 指令。    |
| `utils/memory/hook.js` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `SessionEnd` | 記憶核心區塊、提示詞／失敗喚回、通知公告與記憶擷取。 |

脈絡監控器預設採用 1M 視窗上限；可設定 `CLAUDE_CONTEXT_WINDOW` 覆寫此設定。

## 🌍 翻譯

直接請代理翻譯，或呼叫 `trilingual-translator` 子代理。`translation-expertise` 技能提供譯文風格規範、1:1 結構對齊原則，以及日文／繁體中文術語陷阱防護：

- 英文 ↔ 日文（`日本語`）↔ 繁體中文（`繁體中文`，預設採台灣用語）
- 選用的三階段**初譯 → 校對 → 潤飾**工作流程，將草稿寫入任務的 `translated/` 資料夾
- 支援檔案與網址來源：靜態頁面使用擷取工具，重度使用 JS 的頁面則使用 `agent-browser`／`browser-use`（Playwright 專用於 e2e 測試）

## 🧪 測試

單元測試與整合測試採用 **Vitest**。在包含 `utils/`、`.claude/hooks/` 與專案自建的 `.agents/skills/` 的整體量測範圍內，陳述式、分支、函式與程式碼行數的涵蓋率門檻均為 **95%**。

```bash
pnpm test
pnpm test:coverage   # enforces the 95% coverage floor
```

測試規範位於 `.claude/rules/testing.md`，進階指南則存放於 `docs/testing/`。

端對端（e2e）測試在 `e2e/` 中使用 **Playwright**（在新增 `*.e2e.*` 測試前，空白測試套件也能順利通過）：

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

## 🛡️ 安全性與設定

### 📦 套件管理

pnpm **12.14.0** 透過 `packageManager` 鎖定，並由 `engines.pnpm`／`engineStrict` 強制檢查。所有開發相依套件皆統一使用 `dev` catalog：

```bash
pnpm add -D some-package --save-catalog-name=dev
```

`pnpm-workspace.yaml` 供應鏈安全強化設定：

- `minimumReleaseAge: 10080`——新套件版本須發布滿 7 天才採用
- `strictPeerDependencies: true`
- `engineStrict: true`
- `ignoreScripts: true` 搭配明確的 `allowBuilds`（`esbuild: true`、`agent-browser: false`）
- `trustPolicy: no-downgrade`

### 🔐 權限與安全護欄

工作區權限設定於 `.claude/settings.json`，並由 `utils/harness/hooks.js` 同步套用至各代理環境：

- **允許的操作**：`pnpm` 指令（含可復原的 `pnpm task rm`）、本機 Git 指令（`status`、`diff`、`log`、`add`、`commit`、`switch -c`、`checkout -b`、`rev-parse`、`show`）、僅限執行儲存庫腳本的 `node`（`utils/`、`.claude/hooks/`、`.agents/skills/`），以及基本目錄檢視（`ls`、`dir`、`cd`、`pwd`、`echo`、`type`、`mkdir`）。未預先核准任意執行 `python`、`node`、`cat` 與 `curl`。
- **需經確認**：`git push`、`rebase`、`merge`、`cherry-pick`，以及強制終止訊號（`kill -9`、`pkill`、`killall`）。
- **禁止的操作**：存取機密檔案（`.env*`、`secrets/`、`*.pem`、`*.key`、`credentials.json`、`~/.ssh/`、`~/.aws/`）、`rm`（請改用 `pnpm task rm`——會將檔案移至 `tasks/.trash/` 保留 7 天）、`npm`、`sudo`／系統管理員指令、破壞性 Git 操作（`force push`、`reset --hard`、`clean -fd`、`branch -D`、`tag -d`）以及 `pnpm publish`。

本機覆寫設定請置於 `.claude/settings.local.json`（由 Git 忽略）。

### 🔌 MCP 伺服器

本機 MCP 設定檔位於 `.mcp.json`（由 Git 忽略）。請複製 `.mcp.json.example` 並依本機環境調整路徑。

## 🤝 參與貢獻

這是一個個人工作區，但隨時歡迎 Fork、想法與建議！開啟 PR 前，請先確認 `pnpm check` 全數通過。

外部技能透過 skills.sh（`skills-lock.json`）管理；專案自建技能則存放於 `.agents/skills/`。

## 💖 致謝

- **外部技能**：[skills.sh](https://skills.sh) 生態系，透過 [vercel-labs/skills](https://github.com/vercel-labs/skills) 安裝。各技能作者均已列於上方表格致謝。
- **支援的代理環境**：[Claude Code](https://claude.com/claude-code)、[Codex](https://openai.com/codex/)、[Antigravity CLI](https://antigravity.google/docs/cli/reference) 與 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 📄 授權條款

本儲存庫的原創內容採用 [ISC](./LICENSE) 授權條款。外部技能未隨本儲存庫散布；安裝後仍適用其各自的上游授權條款。
