# kyoten

kyoten (拠点, "base of operations") starts a coding agent inside a kyoten workspace: shared rules
(`AGENTS.md`), tasks that survive sessions, memory, skills, review roles, hooks, and a quality
gate, the same for Claude Code, Codex, the DeepSeek harness, and Antigravity CLI.

```bash
npx kyoten            # Claude Code
npx kyoten codex      # OpenAI Codex CLI
npx kyoten dsh        # DeepSeek harness (dsh web)
npx kyoten dscc       # Claude Code on the DeepSeek API
npx kyoten agy        # Antigravity CLI
```

No clone is needed. The first run offers to create your workspace (the "home", `~/.kyoten`), and
every later run starts the agent there.

## Requirements

- Node.js 24 or newer, git, and pnpm (`corepack enable`; without admin rights:
  `corepack enable --install-directory <a folder on your PATH you can write to>`).
- The agent CLIs you want to use: [Claude Code](https://code.claude.com/docs),
  [Codex](https://developers.openai.com/codex/cli), or
  [DSH](https://deepseekdocs.com/en/docs/user-guide/cli), or Antigravity CLI (`agy`). kyoten does
  not install them.
  `kyoten doctor` lists what is missing.

- Network access on the first `kyoten init`: `pnpm install` downloads the home's dependencies and
  `pnpm workspace:setup` installs the third-party skills from GitHub. Later launches work offline.
- On Windows, pnpm comes from Corepack (`corepack enable` in an administrator shell, or the
  `--install-directory` form above). kyoten needs `pnpm` itself on PATH: the agents call
  `pnpm task`, so `corepack pnpm` alone is not enough.

macOS, Linux, and Windows (PowerShell, cmd, Git Bash) are supported.

## Start

```bash
npx kyoten init       # create ~/.kyoten and install it (pnpm install, pnpm workspace:setup)
npx kyoten doctor     # check Node, git, pnpm, each agent, and the home
npx kyoten            # start Claude Code in the home
```

A new home asks one question: whether to save memory automatically (`[y/N]`, see "What runs in a
home"). `kyoten init --memory on|off` answers it ahead; without a terminal it is off.

Install it globally if you prefer a plain `kyoten` command: `pnpm add -g kyoten` (or
`npm i -g kyoten`). The examples below use `kyoten`.

## Command line

```text
kyoten [--home <dir>] [--no-add-dir] [<agent>] [agent args…]
kyoten [--home <dir>] <command> [options]
```

Only the front of the command line belongs to kyoten: its options, then one word that picks the
agent or the command. Everything after that word goes to the agent unchanged, and kyoten adds no
permission flags.

| Agent    | Starts                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `claude` (the default when the first word is not an agent or a command: `kyoten -c` is `claude -c`)                                       |
| `codex`  | `codex`                                                                                                                                   |
| `dsh`    | `dsh <profile> --patch .dsh/workspace.patch.yml`; the profile is the first argument if it is not an option, else `web` (`kyoten dsh tui`) |
| `dscc`   | `claude` with the DeepSeek profile (below)                                                                                                |
| `agy`    | `agy` (Antigravity CLI)                                                                                                                   |

`--codex` is the same as `codex`. To give Claude a word that is also a kyoten command, name the
agent: `kyoten claude update`.

| Command                                        | Does                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [<dir>] [--no-setup] [--memory on\|off]` | Create a home and install it. With `<dir>`, also make it the default home. An existing kyoten workspace is kept as it is and only installed again |
| `update [--no-setup]`                          | Merge this kyoten's snapshot into a home kyoten created                                                                                           |
| `doctor`                                       | Check prerequisites, agents, Codex and Antigravity trust, memory saving, the dsh path, the dscc key, then `pnpm workspace:check`                  |
| `where`                                        | Print the home on stdout and the rule that chose it on stderr (`cd "$(kyoten where)"`)                                                            |
| `run <script> [args…]`                         | Run a workspace script in the home from any folder (`pnpm <script>` there): `kyoten run task status`                                              |
| `config [get\|set\|unset\|path]`               | Show or change the config file (below)                                                                                                            |
| `reset [--yes] [--all]`                        | Move a home kyoten created aside (below)                                                                                                          |
| `backup [<dir>] [--include-key]`               | Write a backup folder with your memory, config, and local commits (below)                                                                         |
| `restore <dir> [--yes]`                        | Bring a backup folder back into the home (below)                                                                                                  |
| `help`, `version`                              | Help and the version                                                                                                                              |

### Workspace commands from any folder

The workspace's own commands (`pnpm task`, `pnpm memory`, `pnpm tools`, `pnpm check`, …) run in
the home. `kyoten run <script> [args…]` runs `pnpm <script> [args…]` there from wherever you are,
with your terminal and environment, and returns its exit code; `kyoten run` lists the scripts.
Every Fix line the launcher prints uses this form, because `cd "$(kyoten where)"` does not work in
cmd. The scripts' own hints and Fix lines show `pnpm <script> …`; outside the home, run them as
`kyoten run <script> …`.

The script runs in the home, so a relative path in its arguments is resolved from the home, not
from where you typed it. Pass absolute paths instead: `kyoten run task new <name> --repo "$PWD"`,
not `--repo .`, which resolves to the home and starts a task with no repository.

```bash
kyoten run task status
kyoten run memory recall "deploy"
kyoten run install          # pnpm install in the home
```

## The home

The home is the first match of:

1. `--home <dir>`
2. `$KYOTEN_HOME`
3. the clone kyoten runs from, when the current directory is inside it (`pnpm kyoten` in a clone)
4. `"home"` in the config file
5. `~/.kyoten`

Every launch prints which one it used. Any other folder is used only when you name it: a repository
can look like a kyoten workspace, and kyoten runs the home's pnpm scripts and starts agents with its
config. The agent always runs with the home as its working
directory, so the workspace's hooks, tasks, and memory work as they do in a clone. To work on
another repository, start a task for it from the home: `pnpm task new <name> --repo <path>`.
kyoten passes the directory you started it from as `KYOTEN_CALLER_DIR`, and the session brief
mentions it when it is a git repository.

### Projects outside the home

Started inside a git repository that is not the home (found by walking up for `.git`), `kyoten`,
`kyoten codex`, `kyoten dscc`, and `kyoten agy` start the agent with `--add-dir=<repository>` first,
so it can read and edit that repository while its hooks, tasks, and memory stay in the home. The
launch line says so (`kyoten: claude in <home> (default); --add-dir=<repository>`). `dsh` has no
verified flag for this; the session brief still mentions the repository. For multi-step work on it,
start a task: `pnpm task new <name> --repo <path>`. The home's formatter hook leaves edits in that
repository unformatted until a task names it with `--repo`: Prettier loads the repository's own
config, which can be code.

Turn it off for one launch with `kyoten --no-add-dir …`, or always with `"addDir": false` in the
config. A repository that is your home folder itself or above it (a dotfiles repository at `~`) is
never added: it would open every file you have. On Windows, a path with `%` or `!` is not added for
an agent installed as a `.cmd` shim (see the Windows note under Notes per agent).

Already have a clone? Register it as the default home (nothing is copied):

```bash
kyoten init ~/src/kyoten
```

### Config file

`config.json` in `%APPDATA%\kyoten` (Windows), `$XDG_CONFIG_HOME/kyoten`, or `~/.config/kyoten`:

```json
{
  "home": "/absolute/path/to/home",
  "addDir": false,
  "args": { "dscc": ["--dangerously-skip-permissions"] }
}
```

`args` adds default arguments for one agent, before the ones you type. That is the place for a
flag you always want, such as a permission mode: kyoten never adds one itself.

You do not have to edit the file by hand:

```bash
kyoten config                                   # the path and the content
kyoten config set home ~/src/kyoten             # must be a kyoten workspace
kyoten config set args.dscc --dangerously-skip-permissions   # every word after the key is one argument
kyoten config set addDir true                   # true or false
kyoten config get args.dscc
kyoten config unset args.dscc
```

Writes are atomic and checked against the same rules as reading the file.

## dscc: Claude Code on the DeepSeek API

```bash
kyoten dscc --set-key   # paste the key from https://platform.deepseek.com/api_keys (hidden)
kyoten dscc --show      # print the profile, the key masked
kyoten dscc             # start
```

The profile is `dscc.env` in the config folder, or the file named by `$DSCC_PROFILE`. It is
outside every workspace, written with mode 0600 on macOS and Linux, and parsed, never executed:
one literal `KEY=value` per line, `#` comments. It sets the DeepSeek base URL, the key, and the
model mapping.

The key goes only where the profile says:

- Every `ANTHROPIC_*` variable inherited from your shell is dropped, and so are your Claude login
  token (`CLAUDE_CODE_OAUTH_TOKEN`) and the Bedrock, Vertex, and Foundry switches
  (`CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`). `--show` masks every value whose name looks
  secret and the `user:password@` part of a URL.
- The profile may set only `ANTHROPIC_*`, `CLAUDE_CODE_*`, and `API_TIMEOUT_MS`; other lines
  are skipped with a warning.
- `ANTHROPIC_BASE_URL` must be an `https` URL, or dscc refuses to start. A host other than
  `api.deepseek.com` starts with a warning that the key is sent there.

Memory extraction keeps the two providers apart: a dscc session is extracted only from a dscc
session, and a normal one only from a normal one, so a transcript never goes to the other provider.
Entries for the other side wait in the queue until a matching session starts the worker.

`--set-key` reads one line from stdin when stdin is not a terminal (`kyoten dscc --set-key < key.txt`).
In Git Bash's mintty, which is not a terminal to Windows programs, pipe the key or run
`--set-key` from PowerShell or cmd.

## What runs in a home

A home is the full workspace, so its hooks run in every agent session started there:

| What                                     | When                                           | Cost                                                                 |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Audit log (`logs/<date>/logging.jsonl`)  | every tool call, secrets redacted              | local only                                                           |
| Prettier on edited files                 | after edits (Codex: at its next tool or stop)  | local only                                                           |
| Task brief, memory recall, guard         | session start, each prompt, before commands    | local only                                                           |
| Stop loop (`pnpm task check` and verify) | each stop of a session working on a code task  | runs your tests; the agent fixes failures in the same session        |
| Review rounds                            | `pnpm task review` (the Stop loop asks for it) | reviewer and verifier subagents on your plan                         |
| Memory extraction                        | each session end, when saving is on            | one background, tool-less call of the session's own CLI on your plan |

The Stop loop is per task: `kyoten run task set --loop off` turns it off for the current one.

Memory saving starts off in a new home. `kyoten run memory on` turns it on, `kyoten run memory off`
pauses it (recall keeps working; save a note by hand with `kyoten run memory add "…" --force`), and `kyoten doctor` shows the state. The
extraction runs on the CLI the session used (Claude Code, Codex, or Antigravity CLI); `kyoten run
memory set --extract-agent <claude|codex|dsh|agy>` picks one for every job, for example on a
machine where Codex has MCP servers (Codex extraction needs none configured).

## Updating

A home kyoten created is a git repository. Its `kyoten/upstream` branch holds the snapshots kyoten
installed; your branch (`main`) holds them plus your own commits.

```bash
npx kyoten@latest update
```

commits the new snapshot to `kyoten/upstream` and merges it into your branch: a fast-forward when
you changed nothing, a merge commit when you did, and ordinary git conflicts when both sides changed
the same lines (resolve them, `git commit`, then run `update` again). Nothing is overwritten.
`update` refuses to start with uncommitted changes to tracked files. A clone is updated with
`git pull`, not `kyoten update`.

When the home was made by another kyoten version, each launch prints a one-line hint.

**What the snapshot holds.** The tracked files of one kyoten commit: `AGENTS.md`, `CLAUDE.md`, the
harness folders (`.claude/`, `.codex/`, `.agents/`, `.dsh/`), `utils/`, `docs/` (excluding
`docs/images/`), `templates/`, `tools/catalog.json`, the project's own skills, and `package.json`
with its lockfile. Third-party skills are not in it: `pnpm workspace:setup` installs them from
`skills-lock.json`. Your personal state (`tasks/`, `memory/`, `AGENTS.local.md`, `CLAUDE.local.md`,
`logs/`, `tools/local.json`) is ignored by git, so neither the snapshot nor an update touches it.

**Customizing.** Edit the home and commit on `main` (a rule in `AGENTS.md`, a skill, a hook
setting). An update merges the new snapshot with your commits like any git merge.

**Lockfile conflicts.** If you added dependencies in the home and the new snapshot changed
`pnpm-lock.yaml` too, the merge stops on it. Take kyoten's lockfile, let pnpm add yours back, and
finish the merge:

```bash
cd "$(kyoten where)"         # PowerShell: cd (kyoten where)
git checkout --theirs pnpm-lock.yaml
pnpm install                 # re-resolves your package.json changes into the lockfile
git add pnpm-lock.yaml && git commit --no-edit
kyoten update                # finishes the install and setup
```

## Notes per agent

- **Codex** reads the workspace's `.codex/` only when the home is trusted. Accept the trust prompt
  on the first `kyoten codex`, then run `/hooks` once to trust the hooks.
- **Antigravity CLI** (`agy`) reads the workspace's `.agents/` (hooks, roles, skills) once the home
  is trusted: accept the trust prompt on the first `kyoten agy`. `kyoten doctor` checks it.
- **DSH** has no project config; kyoten adds the workspace patch. Install the Claude hooks bridge in
  each DSH profile you start, at the version `dsh --version` prints (see `docs/harness.md` in the
  home). DSH cannot run the hooks from a home path that contains `$`, a backtick, or `"` (or `\` on
  macOS and Linux); `kyoten doctor` reports it.
  The Web UI starts with no workspace selected: click **Choose workspace**, add the home, and select
  it (`kyoten dsh` prints the path). The patch is read once per server, and a session in another
  workspace still runs the home's hooks while it reads that workspace's `AGENTS.md` and skills; its
  session start says so. `kyoten doctor` warns when something already answers on the dsh web port
  (127.0.0.1:3080, or a `--port` in `args.dsh`), such as a `dsh web` started without kyoten.
- **Windows:** an agent installed by npm is a `.cmd` shim, which cannot take arguments containing
  `"`, `%`, or `!` safely. kyoten refuses those arguments with an explanation: type that text inside
  the agent instead. A repository whose path holds `%` or `!` is left out of `--add-dir` for such an
  agent, with a notice, and the agent starts in the home without it.

## Per-agent personas

Each agent can talk in its own voice. `kyoten run memory personalize --for <claude|codex|ds|agy>
--persona "…"` (or `--persona-file "$PWD/persona.md"`) writes `memory/persona.<agent>.md` in the
home; `ds` is shared by `dsh` and `dscc`. kyoten starts every agent with `KYOTEN_AGENT=<agent>`,
and the memory hook applies that agent's file at session start (and names it on each prompt).
Nothing is rewritten at launch, so other sessions in the same home are not affected. An agent
without a file uses the default persona, and `kyoten run memory personalize --off` pauses all of
them. `--for … --reset` removes a file (`kyoten run memory undo` restores it).

The file is markdown like `memory/persona.md`: HTML comments and heading marks are dropped, and the
rendered personalization (this persona plus the shared settings) is at most 1,500 characters. You
can edit it by hand: the hook reads it at every session start, so the next session uses the edit
without `memory init`. A hand-edited file that fails the checks (over the limit, or text that looks
like a secret) is skipped, and that agent falls back to the default persona without a warning;
`--for <agent> --persona-file` runs the same checks and prints the error. Details: `docs/harness.md`.

## Security

- The npm package holds a snapshot of one git commit, never a working tree: untracked and ignored
  files (tasks, memory, logs, local settings, secrets) cannot be in it. The pack step also checks
  every file against a deny list and the exact expected file list. The deny list ignores case. At
  the top level it refuses `tasks/`, `memory/`, `logs/`, `coverage/`, `tools/local.json`, and
  `.mcp.json`; at any depth `node_modules/`, `secrets/`, `*.local.*`, `.npmrc`, `*.env` and `.env*`,
  `credentials.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `id_rsa*`, and `id_ed25519*`. It
  checks names, not contents. Templates such as
  `.env.example` and `dscc.env.example` are allowed, as is the one tracked
  `templates/memory/AGENTS.local.md`.
- kyoten's own git commands (init, update, backup, restore, reset) run without the caller's
  `GIT_*` environment variables, so a git hook or IDE terminal cannot point them at another
  repository. The agent CLIs and kyoten's pnpm calls (setup, workspace check, memory export and
  import, `kyoten run`) get your environment without the variables git sets to pick a repository
  (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_PARAMETERS`, …); your own git settings
  such as `GIT_SSH_COMMAND` stay.
- Files holding a key or your data (the dscc profile, backups) are written through a randomly
  named temporary file created exclusively with mode 0600, then renamed into place.
- The package has no install scripts. kyoten itself makes no network calls; `pnpm install` and
  `pnpm workspace:setup` make the ones they always make.
- Commands run without a shell. On Windows, `.cmd` shims go through `cmd.exe` with strict quoting.

## Remove

`kyoten reset` moves a home kyoten created aside; delete the renamed folder yourself when you are
sure. A global install is removed with `pnpm remove -g kyoten`.

### Reset

```bash
kyoten reset            # shows what is in the home, then asks [y/N]
kyoten reset --yes      # no terminal, or no question
kyoten reset --all      # also move the config folder (config.json, the dscc profile)
```

Only for a home kyoten created. A clone or a registered workspace is not touched: stop using it
with `kyoten config unset home`. Before asking, reset shows the home, the local commits that are not
on `kyoten/upstream` (the count and up to five subjects), uncommitted files, open tasks, and memory
notes, and suggests `kyoten backup`. It then renames the home to `<home>.removed-<YYYYMMDD-HHMMSS>`
(local time) and prints the command that undoes it (`mv` on macOS and Linux, `Move-Item` on
Windows). Nothing is deleted. If the config's `home` pointed at the reset home, it is unset.

## Backup and restore

```bash
kyoten backup                   # ./kyoten-backup-<YYYYMMDD-HHMMSS> in the current folder
kyoten backup ~/safe/kyoten     # a new (or empty) folder of your choice
kyoten backup --include-key     # also copy the DeepSeek key file
kyoten restore ~/safe/kyoten    # into the home (created first if missing)
```

A backup is a new folder, mode 0700 on macOS and Linux (it is never an existing non-empty one). It
holds:

| File            | What                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `memory.tar.gz` | `pnpm memory export` of the home: notes, personalization, tasks, and `resources/`               |
| `config.json`   | kyoten's config file, when there is one                                                         |
| `home.json`     | `.kyoten/home.json`, for a home kyoten created                                                  |
| `local.bundle`  | a `git bundle` of `main` and `kyoten/upstream`, only for a home kyoten created with own commits |
| `dscc.env`      | the DeepSeek profile, only with `--include-key` (mode 0600)                                     |
| `manifest.json` | kyoten version, time, and the sha256 and size of every file above                               |

**The folder holds personal data** (your notes, settings, and with `--include-key` your API key).
Keep it private and out of cloud folders you share. It holds a `.gitignore` of `*`, so a backup made
inside a project is not committed with it.

`restore` checks the manifest and the sha256 of every file first and refuses a changed folder or an
unknown file name. The checksums catch damage, not a deliberate change (whoever can write the folder
can rewrite the manifest too), so restore only a backup you made. It then merges, and never
overwrites:

- The home is created first if it is missing. A home with uncommitted changes to tracked files is
  refused.
- `local.bundle` is fetched (with git's object checks) into `refs/kyoten/restored`. kyoten lists
  your commits in it, warns when they change files that run code or steer the agents (the harness
  folders such as `.githooks/`, `.claude/`, `.codex/`, `.agents/`, `.dsh/`, `.gemini/`, and
  `.github/`, `utils/`, `tools/`, `package.json`, the pnpm files, `.mcp.json`, the test, lint, and
  TypeScript configs, `AGENTS.md`, `CLAUDE.md`, and the git-ignored `tasks/` and `memory/`, which a
  backup never tracks), and asks `[y/N]` before it merges them into `main` (without a terminal,
  pass `--yes`; on no they stay in `refs/kyoten/restored`). The warning covers every file the merge
  changes, measured from the merge base git uses, under both names for a moved file. A fresh home
  has its own snapshot commit, so the old snapshot in the bundle is linked first (keeping the new
  files) and then used as the merge base, as in `kyoten update`; a bundle whose `main` shares no
  history with that snapshot is refused. Conflicts stay as ordinary git conflicts.
- `pnpm memory import` merges the notes (never `--replace`). It shows the `--dry-run` result first
  and asks `[y/N]`; without a terminal, pass `--yes`.
- `config.json` and `dscc.env` are copied only where none exists; otherwise the current one is kept
  and kyoten says so. A `home` in the backup's config that names another folder is left out.

## Developing kyoten

The code is in `utils/kyoten/` of the kyoten repository (https://github.com/shino369/kyoten).

```bash
pnpm kyoten doctor          # run the CLI from the clone (the clone is the home)
pnpm kyoten:pack            # build dist/kyoten-<version>.tgz from HEAD and check it
npx --yes --package ./dist/kyoten-<version>.tgz -- kyoten doctor   # the npx path, before publishing
```

`kyoten:pack` packs the HEAD commit, so commit first. Publishing is a manual step.
