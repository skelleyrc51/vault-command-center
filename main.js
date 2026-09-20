"use strict";

const { Plugin, ItemView, Notice, Modal, FileSystemAdapter, setIcon } = require("obsidian");
const { execFile } = require("child_process");

const VIEW_TYPE = "vault-command-center-view";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Actions are plain prompts handed to `claude -p` with the vault as cwd.
 *
 * `writes: true` means the action is expected to modify vault files. Those
 * require an explicit confirmation before running — see confirmRun().
 *
 * Deliberately absent: any action that ingests unreviewed external content
 * (web scrapes, downloaded transcripts, third-party dumps) and acts on it
 * unattended. Text from an untrusted source can carry instructions aimed at
 * the agent, and a button that triages it without a human reading it first is
 * a prompt-injection path straight into the vault. Read the input, then ask.
 */
const ACTIONS = [
  {
    id: "health",
    label: "Vault health",
    writes: false,
    prompt:
      "Report on this Obsidian vault's health: list unresolved links, orphaned notes, " +
      "and notes missing YAML frontmatter. Report only - do not modify any files.",
  },
  {
    id: "watchlist-audit",
    label: "Audit watchlist",
    writes: false,
    prompt:
      "Compare the ticker notes in Watchlist/ against the SEED array in " +
      "'../Stock Watch List/index.html'. List any symbols present in one but not the other, " +
      "and any note whose category frontmatter disagrees with the dashboard. Report only.",
  },
  {
    id: "empty-sections",
    label: "Find empty notes",
    writes: false,
    prompt:
      "List every note under Watchlist/ whose '## Thesis' section is still empty, " +
      "grouped by category. Report only - do not modify any files.",
  },
  {
    id: "daily",
    label: "Daily note",
    writes: true,
    prompt:
      "Create or update today's daily note. Summarise what changed in this vault today " +
      "based on file modification times, and link the notes involved.",
  },
];

class CommandCenterView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.running = null;
    this.child = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Vault Command Center";
  }
  getIcon() {
    return "gauge";
  }

  async onOpen() {
    this.render();
    // Recompute metrics when the vault index changes, not on a timer.
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.renderMetrics()));
  }

  async onClose() {
    if (this.child) this.child.kill();
  }

  // ---- Metrics -------------------------------------------------------------
  // Every figure below is derived from Obsidian's own index at render time.
  // Nothing here is hardcoded; if a number cannot be computed it is not shown.

  computeMetrics() {
    const files = this.app.vault.getMarkdownFiles();

    let broken = 0;
    const unresolved = this.app.metadataCache.unresolvedLinks || {};
    for (const src of Object.keys(unresolved)) {
      broken += Object.keys(unresolved[src]).length;
    }

    const linkedTo = new Set();
    const resolved = this.app.metadataCache.resolvedLinks || {};
    for (const src of Object.keys(resolved)) {
      for (const dst of Object.keys(resolved[src])) linkedTo.add(dst);
    }
    const orphans = files.filter((f) => !linkedTo.has(f.path)).length;

    let openTasks = 0;
    let doneTasks = 0;
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache || !cache.listItems) continue;
      for (const item of cache.listItems) {
        if (item.task === " ") openTasks++;
        else if (typeof item.task === "string") doneTasks++;
      }
    }

    const newest = files.reduce((max, f) => Math.max(max, f.stat.mtime), 0);

    return { notes: files.length, broken, orphans, openTasks, doneTasks, newest };
  }

  renderMetrics() {
    if (!this.metricsEl) return;
    this.metricsEl.empty();
    const m = this.computeMetrics();

    const cards = [
      { label: "Notes", value: String(m.notes) },
      { label: "Broken links", value: String(m.broken), warn: m.broken > 0 },
      { label: "Orphans", value: String(m.orphans), warn: m.orphans > 0 },
      {
        label: "Open tasks",
        value: m.openTasks + m.doneTasks > 0 ? `${m.openTasks} / ${m.openTasks + m.doneTasks}` : "0",
      },
    ];

    for (const c of cards) {
      const card = this.metricsEl.createDiv({ cls: "vcc-card" + (c.warn ? " vcc-card-warn" : "") });
      card.createDiv({ cls: "vcc-card-label", text: c.label });
      card.createDiv({ cls: "vcc-card-value", text: c.value });
    }

    if (this.updatedEl) {
      this.updatedEl.setText(
        m.newest ? `last edit ${new Date(m.newest).toLocaleString()}` : "empty vault"
      );
    }
  }

  // ---- Layout --------------------------------------------------------------

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("vcc-container");

    const header = root.createDiv({ cls: "vcc-header" });
    header.createDiv({ cls: "vcc-title", text: "Vault Command Center" });
    this.updatedEl = header.createDiv({ cls: "vcc-status" });

    this.metricsEl = root.createDiv({ cls: "vcc-metrics" });
    this.renderMetrics();

    const actions = root.createDiv({ cls: "vcc-actions" });
    this.buttons = [];
    for (const action of ACTIONS) {
      const btn = actions.createEl("button", { cls: "vcc-btn" });
      btn.createSpan({ text: action.label });
      if (action.writes) btn.createSpan({ cls: "vcc-writes", text: "writes" });
      btn.addEventListener("click", () => this.confirmRun(action));
      this.buttons.push(btn);
    }

    const custom = root.createDiv({ cls: "vcc-custom" });
    this.promptInput = custom.createEl("input", {
      type: "text",
      cls: "vcc-input",
      attr: { placeholder: "Ask Claude something about this vault…" },
    });
    const runBtn = custom.createEl("button", { cls: "vcc-btn vcc-btn-run", text: "Run" });
    const runCustom = () => {
      const text = this.promptInput.value.trim();
      if (!text) return;
      this.confirmRun({ id: "custom", label: "Custom prompt", prompt: text, writes: true });
    };
    runBtn.addEventListener("click", runCustom);
    this.promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runCustom();
    });
    this.buttons.push(runBtn);

    const outPanel = root.createDiv({ cls: "vcc-panel" });
    const outHeader = outPanel.createDiv({ cls: "vcc-panel-header" });
    this.outTitle = outHeader.createSpan({ text: "Output" });
    this.cancelBtn = outHeader.createEl("button", { cls: "vcc-cancel", text: "Cancel" });
    this.cancelBtn.hide();
    this.cancelBtn.addEventListener("click", () => {
      if (this.child) {
        this.child.kill();
        this.appendOut("\n— cancelled —\n");
      }
    });
    this.outEl = outPanel.createEl("pre", { cls: "vcc-output" });
    this.outEl.setText("No run yet.");
  }

  // ---- Execution -----------------------------------------------------------

  confirmRun(action) {
    if (this.running) {
      new Notice("A run is already in progress.");
      return;
    }
    new ConfirmModal(this.app, action, () => this.run(action)).open();
  }

  setBusy(busy) {
    this.running = busy ? true : null;
    for (const b of this.buttons) b.toggleClass("vcc-disabled", busy);
    for (const b of this.buttons) (b.disabled = busy);
    if (busy) this.cancelBtn.show();
    else this.cancelBtn.hide();
  }

  appendOut(text) {
    this.outEl.setText(this.outEl.getText() + text);
    this.outEl.scrollTop = this.outEl.scrollHeight;
  }

  run(action) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Vault Command Center requires a local vault.");
      return;
    }
    const cwd = adapter.getBasePath();

    this.setBusy(true);
    this.outTitle.setText(`Output — ${action.label}`);
    this.outEl.setText(`$ claude -p "${action.prompt}"\n\n`);

    const started = Date.now();
    this.child = execFile(
      "claude",
      ["-p", action.prompt],
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        this.child = null;
        const secs = ((Date.now() - started) / 1000).toFixed(1);

        if (stdout) this.appendOut(stdout);
        if (stderr) this.appendOut("\n[stderr]\n" + stderr);

        if (err) {
          // Report the real failure rather than a success notice.
          let hint = "";
          if (err.code === "ENOENT") {
            hint =
              "\n\n'claude' was not found on PATH.\nObsidian inherits the PATH it was " +
              "launched with - if you changed PATH after starting Obsidian, restart it.";
          } else if (err.killed) {
            hint = `\n\nRun exceeded ${RUN_TIMEOUT_MS / 1000}s and was terminated.`;
          }
          this.appendOut(`\n\n— failed after ${secs}s: ${err.message}${hint}\n`);
          new Notice(`${action.label}: failed`);
        } else if (!stdout.trim()) {
          this.appendOut(
            `\n— finished in ${secs}s with no output.\n\n` +
              "Claude ran non-interactively, so any tool call needing approval had no way " +
              "to get one. If this action was meant to change files, it likely did nothing.\n"
          );
          new Notice(`${action.label}: no output`);
        } else {
          this.appendOut(`\n— finished in ${secs}s\n`);
          new Notice(`${action.label}: done`);
        }

        this.setBusy(false);
        this.renderMetrics();
      }
    );
  }
}

class ConfirmModal extends Modal {
  constructor(app, action, onConfirm) {
    super(app);
    this.action = action;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Run: ${this.action.label}` });
    contentEl.createEl("p", {
      cls: "vcc-modal-note",
      text: this.action.writes
        ? "This action may create or modify files in your vault."
        : "This action is read-only.",
    });
    contentEl.createEl("p", { text: "Prompt sent to Claude:" });
    contentEl.createEl("pre", { cls: "vcc-modal-prompt", text: this.action.prompt });

    const row = contentEl.createDiv({ cls: "vcc-modal-buttons" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const go = row.createEl("button", { cls: "mod-cta", text: "Run" });
    go.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class VaultCommandCenterPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new CommandCenterView(leaf, this));

    this.addRibbonIcon("gauge", "Open Vault Command Center", () => this.activateView());

    this.addCommand({
      id: "open-vault-command-center",
      name: "Open Vault Command Center",
      callback: () => this.activateView(),
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      // Side pane, so opening the dashboard never takes over the note you're reading.
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  onunload() {}
};
