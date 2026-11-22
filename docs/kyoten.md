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

macOS, Linux, and Windows (PowerShell, cmd, Git Bash) are supported.

## Start

```bash
npx kyoten init       # create ~/.kyoten and install it (pnpm install, pnpm workspace:setup)
npx kyoten doctor     # check Node, git, pnpm, each agent, and the home
npx kyoten            # start Claude Code in the home
```

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
| `agy`    | `agy` (Antigravity CLI), no added arguments                                                                                               |

`--codex` is the same as `codex`. To give Claude a word that is also a kyoten command, name the
agent: `kyoten claude update`.

| Command                          | Does                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [<dir>] [--no-setup]`      | Create a home and install it. With `<dir>`, also make it the default home. An existing kyoten workspace is kept as it is and only installed again |
| `update [--no-setup]`            | Merge this kyoten's snapshot into a home kyoten created                                                                                           |
| `doctor`                         | Check prerequisites, agents, Codex and Antigravity trust, memory saving, the dsh path, the dscc key, then `pnpm workspace:check`                  |
| `where`                          | Print the home on stdout and the rule that chose it on stderr (`cd "$(kyoten where)"`)                                                            |
| `run <script> [args…]`           | Run a workspace script in the home from any folder (`pnpm <script>` there): `kyoten run task status`                                              |
| `config [get\|set\|unset\|path]` | Show or change the config file (below)                                                                                                            |
| `reset [--yes] [--all]`          | Move a home kyoten created aside (below)                                                                                                          |
| `backup [<dir>] [--include-key]` | Write a backup folder with your memory, config, and local commits (below)                                                                         |
| `restore <dir> [--yes]`          | Bring a backup folder back into the home (below)                                                                                                  |
| `help`, `version`                | Help and the version                                                                                                                              |

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
`kyoten codex`, and `kyoten dscc` start the agent with `--add-dir=<repository>` first, so it can
read and edit that repository while its hooks, tasks, and memory stay in the home. The launch line
says so (`kyoten: claude in <home> (default); --add-dir=<repository>`). `dsh` and `agy` have no
verified flag for this; the session brief still mentions the repository. For multi-step work on it,
start a task: `pnpm task new <name> --repo <path>`.

Turn it off for one launch with `kyoten --no-add-dir …`, or always with `"addDir": false` in the
config.

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

- Every `ANTHROPIC_*` variable inherited from your shell is dropped, and so are the Bedrock,
  Vertex, and Foundry switches (`CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`).
- The profile may set only `ANTHROPIC_*`, `CLAUDE_CODE_*`, and `API_TIMEOUT_MS`; other lines
  are skipped with a warning.
- `ANTHROPIC_BASE_URL` must be an `https` URL, or dscc refuses to start. A host other than
  `api.deepseek.com` starts with a warning that the key is sent there.

`--set-key` reads one line from stdin when stdin is not a terminal (`kyoten dscc --set-key < key.txt`).
In Git Bash's mintty, which is not a terminal to Windows programs, pipe the key or run
`--set-key` from PowerShell or cmd.

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
  the agent instead.

## Security

- The npm package holds a snapshot of one git commit, never a working tree: untracked and ignored
  files (tasks, memory, logs, local settings, secrets) cannot be in it. The pack step also checks
  every file against a deny list and the exact expected file list. The deny list ignores case and
  matches at any depth: `tasks/`, `memory/`, `logs/`, `node_modules/`, `coverage/`, `secrets/`,
  `*.local.*`, `tools/local.json`, `.mcp.json`, `.npmrc`, `*.env` and `.env*`, `credentials.json`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `id_rsa*`, and `id_ed25519*`. Templates such as
  `.env.example` and `dscc.env.example` are allowed, as is the one tracked
  `templates/memory/AGENTS.local.md`.
- kyoten's own git commands (init, update, backup, restore, reset) run without the caller's
  `GIT_*` environment variables, so a git hook or IDE terminal cannot point them at another
  repository. The agent CLIs still get your environment unchanged.
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
Keep it private and out of git and cloud folders you share.

`restore` checks the manifest and the sha256 of every file first and refuses a changed folder or an
unknown file name. It then merges, and never overwrites:

- The home is created first if it is missing. A home with uncommitted changes to tracked files is
  refused.
- `local.bundle` is fetched into `refs/kyoten/restored` and merged into `main`. A fresh home has its
  own snapshot commit, so the old snapshot in the bundle is linked first (keeping the new files) and
  then used as the merge base, as in `kyoten update`. Conflicts stay as ordinary git conflicts.
- `pnpm memory import` merges the notes (never `--replace`). It shows the `--dry-run` result first
  and asks `[y/N]`; without a terminal, pass `--yes`.
- `config.json` and `dscc.env` are copied only where none exists; otherwise the current one is kept
  and kyoten says so.

## Developing kyoten

The code is in `utils/kyoten/` of the kyoten repository (https://github.com/shino369/kyoten).

```bash
pnpm kyoten doctor          # run the CLI from the clone (the clone is the home)
pnpm kyoten:pack            # build dist/kyoten-<version>.tgz from HEAD and check it
npx --yes --package ./dist/kyoten-<version>.tgz -- kyoten doctor   # the npx path, before publishing
```

`kyoten:pack` packs the HEAD commit, so commit first. Publishing is a manual step.
