# Vault Command Center

An Obsidian dashboard that reports real metrics about your vault and launches
[Claude Code](https://claude.com/claude-code) actions against it, with the output shown to you.

Desktop only — it shells out to the `claude` CLI.

## What it does

**Metrics**, computed from Obsidian's own index every time the view renders:

| Element | Source |
|---|---|
| Thesis coverage (hero gauge) | notes whose `## Thesis` heading is followed by a non-heading section, over those that have the heading at all |
| Notes | `vault.getMarkdownFiles()` |
| Broken links | `metadataCache.unresolvedLinks` |
| Orphans | notes absent from `metadataCache.resolvedLinks` |
| Tasks | `task` entries in `metadataCache` list items |
| Latest edit | highest `stat.mtime`; click to open the note |

Nothing is hardcoded. If a figure can't be derived, it isn't shown — with no
note carrying the heading, the gauge says so instead of rendering 0%.

Coverage is read from `metadataCache.sections` rather than by opening files, so
the panel re-renders on every index change without touching disk.

## Appearance

Corner-bracketed panels, uppercase monospace labels and an accent gauge, after
the dashboard that circulated alongside the original script.

The accent resolves through `--vcc-accent`, falling back to the theme's
`--color-orange` and then to `--text-accent`. Override it in a CSS snippet:

```css
.vcc-container { --vcc-accent: #7c9cff; }
```

Everything else comes from Obsidian's theme variables, so light mode works and
the panel follows the active theme. There are no hardcoded colours.

**Actions** — each one runs `claude -p` with the vault as the working directory:

- **Vault health** — unresolved links, orphans, notes missing frontmatter *(read-only)*
- **Audit watchlist** — reconciles ticker notes against a source dashboard *(read-only)*
- **Find empty notes** — notes whose `## Thesis` section is still blank *(read-only)*
- **Daily note** — summarises today's changes *(writes)*
- **Custom prompt** — free-text box *(writes)*

Output **streams as it arrives** rather than appearing all at once when the run
ends. Answer text, reasoning and tool calls are styled differently, and the run
finishes with its real duration and cost, taken from the `result` event:

```
⚙ Read(NVDA.md)
The thesis section is still empty for 4 of the 35 notes…

— done in 4.2s · $0.0041
```

**Cancel** actually stops the run. On Windows `child.kill()` signals the shim and
leaves `claude.exe` running; this uses `taskkill /T` on the process tree.

Every run shows a confirmation modal with the **exact argv** first — including the
permission mode, so what the run is allowed to do is visible before you agree to
it. Actions that can modify files carry a `writes` badge.

## Permissions

`claude -p` is non-interactive, so anything that would raise a permission prompt
has nobody to answer it. The two kinds of action are therefore launched
differently:

| Action | Flags | Effect |
|---|---|---|
| read-only | `--permission-mode manual --permission-prompts none` | Reads and searches. Writes are refused. |
| `writes: true` | `--permission-mode acceptEdits` | File edits are approved. Bash and the other shell tools are still refused. |

Both directions are verified, not assumed: a read-only action asked to create a
file reports that it couldn't and leaves no file behind, and a writing action
asked to create one does.

`--dangerously-skip-permissions` is not used anywhere and shouldn't be added. The
modal is the approval step; the permission mode is the floor under it.

## Design rules

**Never display a number you can't derive.** A dashboard showing plausible
fabricated metrics is worse than one showing none — it looks operational while
reporting nothing.

**Never report success you haven't verified.** The panel shows the stream,
`stderr`, the exit code, and the elapsed time. A run that exits cleanly with
nothing to show is reported as "no output", not as a success. A line on the
stream that isn't valid JSON is printed raw rather than dropped — a crash or a
`PATH` error arrives that way, and swallowing it would fake a clean run.

**Don't feed unreviewed external content to an agent with write access.** There
is deliberately no "triage my inbox" or "research the web and write to my vault"
button. Text from an untrusted source can carry instructions aimed at the agent,
and a button that acts on it unattended is a prompt-injection path into your
notes. Read the input, then ask.

**Never pass a prompt through a shell.** `spawn` takes arguments as an array with
no shell, so quotes and metacharacters in a prompt can't alter the command. Note
that `stdin` is closed rather than inherited: `claude -p` otherwise waits about
three seconds for piped input that never comes, and warns on `stderr`.

## Install

Manual, until this is in the community catalogue:

1. Copy `manifest.json`, `main.js` and `styles.css` into
   `<vault>/.obsidian/plugins/vault-command-center/`
2. Settings → Community plugins → enable **Vault Command Center**
3. Open from the ribbon (gauge icon) or the command palette

`deploy.ps1` does step 1 — set `$VaultPath` at the top first.

## Requirements

- Obsidian 1.4.0+, desktop
- The `claude` CLI on your `PATH`

Obsidian inherits the `PATH` it was launched with. If you add `claude` to `PATH`
while Obsidian is running, restart Obsidian or every run fails with `ENOENT` —
the plugin says as much when it happens.

## Editing the actions

`ACTIONS` at the top of `main.js`. Each entry needs `id`, `label`, `prompt`, and
`writes`. Set `writes: true` for anything that can change files; it drives the
badge, the permission mode, and the wording of the confirmation modal.

## Development

The plugin has no build step and no runtime dependencies — `main.js` is what
ships. `package.json` exists only to run the tests:

```
npm test
```

The two pure parts are covered: `buildArgs`, which decides the permission mode,
and `routeLine`, which turns one line of `--output-format stream-json` into
something worth rendering. That filtering is the whole feature rather than a
nicety — on a measured run, 86% of the lines on the stream were `system/init`,
`system/commands_changed` and hook chatter carrying nothing a reader wants.

The test fixtures are trimmed copies of real `claude` output, not invented
shapes. If you add a branch to `routeLine`, capture a real event for it:

```
claude -p "…" --output-format stream-json --verbose --include-partial-messages
```

`main.js` tolerates being `require`d without Obsidian present (the import is
wrapped, and the base classes fall back to empty classes) purely so the tests can
load it without a bundler.

## Attribution

The idea of a Claude Code launcher embedded in an Obsidian dashboard came from a
publicly circulated setup script ("Chase Command Center"). This is an independent
rewrite — no code is carried over — built around the design rules above.

## License

MIT — see [LICENSE](LICENSE).
