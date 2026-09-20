# Vault Command Center

An Obsidian dashboard that reports real metrics about your vault and launches
[Claude Code](https://claude.com/claude-code) actions against it, with the output shown to you.

Desktop only — it shells out to the `claude` CLI.

## What it does

**Metrics**, computed from Obsidian's own index every time the view renders:

| Card | Source |
|---|---|
| Notes | `vault.getMarkdownFiles()` |
| Broken links | `metadataCache.unresolvedLinks` |
| Orphans | notes absent from `metadataCache.resolvedLinks` |
| Open tasks | `task` entries in `metadataCache` list items |

Nothing is hardcoded. If a figure can't be derived, it isn't shown.

**Actions** — each one runs `claude -p "<prompt>"` with the vault as the working directory:

- **Vault health** — unresolved links, orphans, notes missing frontmatter *(read-only)*
- **Audit watchlist** — reconciles ticker notes against a source dashboard *(read-only)*
- **Find empty notes** — notes whose `## Thesis` section is still blank *(read-only)*
- **Daily note** — summarises today's changes *(writes)*
- **Custom prompt** — free-text box *(writes)*

Every run shows a confirmation modal with the exact prompt first. Actions that can
modify files carry a `writes` badge.

## Design rules

**Never display a number you can't derive.** A dashboard showing plausible
fabricated metrics is worse than one showing none — it looks operational while
reporting nothing.

**Never report success you haven't verified.** The output panel shows `stdout`,
`stderr`, and elapsed time. A run that produces no output says so explicitly, and
explains why: `claude -p` is non-interactive, so any tool call needing approval
has no way to get one, and a writing action may have done nothing.

**Don't feed unreviewed external content to an agent with write access.** There
is deliberately no "triage my inbox" or "research the web and write to my vault"
button. Text from an untrusted source can carry instructions aimed at the agent,
and a button that acts on it unattended is a prompt-injection path into your
notes. Read the input, then ask.

**Use `execFile`, not `exec`.** Arguments pass as an array with no shell, so
quotes and metacharacters in a prompt can't alter the command.

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
badge and the wording of the confirmation modal.

## Attribution

The idea of a Claude Code launcher embedded in an Obsidian dashboard came from a
publicly circulated setup script ("Chase Command Center"). This is an independent
rewrite — no code is carried over — built around the design rules above.

## License

MIT — see [LICENSE](LICENSE).
