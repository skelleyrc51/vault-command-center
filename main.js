"use strict";

// Obsidian only exists when Node runs inside the app. The line router further down
// is pure and is exercised by `npm test`, where this require necessarily fails; the
// class defaults keep module evaluation from throwing on `extends undefined`.
let obsidian = {};
try {
  obsidian = require("obsidian");
} catch (e) {
  /* under test */
}
const {
  Plugin = class {},
  ItemView = class {},
  Notice = class {},
  Modal = class {},
  FileSystemAdapter = class {},
} = obsidian;
const { spawn } = require("child_process");

const VIEW_TYPE = "vault-command-center-view";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

// ---- Argument construction -------------------------------------------------
// Read-only actions deny anything that would prompt, so they cannot touch the
// vault. Writing actions get acceptEdits - file edits are approved, Bash and the
// other shell tools still are not. The confirmation modal shows this argv
// verbatim, so the mode is visible before the run is agreed to.

const STREAM_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];

function buildArgs(action) {
  const args = ["-p", action.prompt, ...STREAM_ARGS];
  if (action.writes) {
    args.push("--permission-mode", "acceptEdits");
  } else {
    args.push("--permission-mode", "manual", "--permission-prompts", "none");
  }
  return args;
}

// ---- Stream routing --------------------------------------------------------
// `claude --output-format stream-json` emits one JSON object per line, and most of
// it is noise: a single-word answer measured 85KB, of which system/init and
// system/commands_changed alone were 72KB. routeLine keeps the parts a human needs
// and drops the rest, returning null for anything not worth showing.

function routeLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let ev;
  try {
    ev = JSON.parse(trimmed);
  } catch (e) {
    // Not JSON. Show it rather than discard it - a crash or a PATH error arrives
    // on stdout as plain text, and silently dropping it would fake a clean run.
    return { kind: "raw", text: trimmed };
  }

  if (ev.type === "stream_event") {
    const inner = ev.event || {};
    if (inner.type === "content_block_delta") {
      const delta = inner.delta || {};
      if (delta.type === "text_delta") return { kind: "text", text: delta.text };
      if (delta.type === "thinking_delta") return { kind: "thinking", text: delta.thinking };
    }
    // signature_delta and input_json_delta carry no text a human can read.
    return null;
  }

  if (ev.type === "assistant") {
    // Text already arrived delta by delta; only the tool calls are new here.
    const content = (ev.message && ev.message.content) || [];
    for (const block of content) {
      if (block.type === "tool_use") return { kind: "tool", text: toolLabel(block) };
    }
    return null;
  }

  if (ev.type === "result") {
    return {
      kind: "result",
      ok: !ev.is_error,
      durationMs: ev.duration_ms,
      costUsd: ev.total_cost_usd,
    };
  }

  if (ev.type === "system" && ev.subtype === "status") {
    return { kind: "status", text: ev.status };
  }

  return null;
}

// "Read(NVDA.md)" - enough to follow what the agent is touching without printing
// an absolute path per call.
const TOOL_ARG_KEYS = ["file_path", "path", "notebook_path", "pattern", "command", "query", "url"];

function toolLabel(block) {
  const input = block.input || {};
  let arg = "";
  for (const key of TOOL_ARG_KEYS) {
    if (typeof input[key] === "string" && input[key]) {
      arg = input[key];
      break;
    }
  }
  if (!arg) return block.name;

  const parts = arg.split(/[\\\/]/);
  if (parts.length > 1) arg = parts[parts.length - 1];
  if (arg.length > 60) arg = arg.slice(0, 57) + "...";

  return block.name + "(" + arg + ")";
}

// ---- Section inspection ----------------------------------------------------
// Both read the metadata index only. `sections` lists every block in document
// order with its line range, so "is there a paragraph between this heading and
// the next one" is answerable without opening the file.

function findHeadingLine(cache, name) {
  if (!cache || !cache.headings) return -1;
  const target = name.toLowerCase();
  for (const h of cache.headings) {
    if (String(h.heading).trim().toLowerCase() === target) return h.position.start.line;
  }
  return -1;
}

function sectionExists(cache, name) {
  return findHeadingLine(cache, name) !== -1;
}

function sectionHasBody(cache, name) {
  const start = findHeadingLine(cache, name);
  if (start === -1 || !cache.sections) return false;

  let next = Infinity;
  for (const h of cache.headings) {
    const line = h.position.start.line;
    if (line > start && line < next) next = line;
  }

  return cache.sections.some(
    (s) => s.type !== "heading" && s.position.start.line > start && s.position.start.line < next
  );
}

function relativeAge(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

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
    // Closing the pane must not leave an orphaned claude process running.
    if (this.child) killTree(this.child);
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

    // Coverage: of the notes that have a "## Thesis" heading, how many have
    // anything written under it. Read from the index rather than from disk - a
    // heading followed immediately by the next heading has an empty section,
    // and cache.sections already says so. Re-rendering stays free.
    let hasThesis = 0;
    let filledThesis = 0;
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!sectionExists(cache, "thesis")) continue;
      hasThesis++;
      if (sectionHasBody(cache, "thesis")) filledThesis++;
    }

    let newest = null;
    for (const f of files) {
      if (!newest || f.stat.mtime > newest.stat.mtime) newest = f;
    }

    return {
      notes: files.length,
      broken,
      orphans,
      openTasks,
      doneTasks,
      hasThesis,
      filledThesis,
      newest,
    };
  }

  renderMetrics() {
    if (!this.metricsEl) return;
    const m = this.computeMetrics();

    // ---- hero gauge ----
    this.gaugeEl.empty();
    if (m.hasThesis > 0) {
      const pct = Math.round((m.filledThesis / m.hasThesis) * 100);
      const head = this.gaugeEl.createDiv({ cls: "vcc-gauge-head" });
      head.createSpan({ cls: "vcc-gauge-label", text: "◈ Thesis coverage · Watchlist" });
      head.createSpan({
        cls: "vcc-gauge-age",
        text: m.newest ? `last edit ${relativeAge(m.newest.stat.mtime)}` : "",
      });

      const body = this.gaugeEl.createDiv({ cls: "vcc-gauge-body" });
      body.createDiv({ cls: "vcc-gauge-pct", text: `${pct}` }).createSpan({
        cls: "vcc-gauge-pct-sign",
        text: "%",
      });

      const track = body.createDiv({ cls: "vcc-gauge-track" });
      track.createDiv({ cls: "vcc-gauge-fill" }).style.width = `${pct}%`;

      const tally = body.createDiv({ cls: "vcc-gauge-tally" });
      tally.createDiv({ cls: "vcc-gauge-tally-value", text: String(m.filledThesis) });
      tally.createDiv({ cls: "vcc-gauge-tally-total", text: `/ ${m.hasThesis}` });
    } else {
      this.gaugeEl.createDiv({
        cls: "vcc-gauge-empty",
        text: "No notes with a ## Thesis section yet.",
      });
    }

    // ---- cards ----
    this.cardsEl.empty();
    const cards = [
      { label: "Notes", value: String(m.notes) },
      { label: "Broken links", value: String(m.broken), warn: m.broken > 0 },
      { label: "Orphans", value: String(m.orphans), warn: m.orphans > 0 },
      {
        label: "Tasks",
        value:
          m.openTasks + m.doneTasks > 0
            ? `${m.doneTasks} / ${m.openTasks + m.doneTasks}`
            : "0",
      },
    ];
    for (const c of cards) {
      const card = this.cardsEl.createDiv({ cls: "vcc-card" + (c.warn ? " vcc-card-warn" : "") });
      card.createDiv({ cls: "vcc-card-label", text: c.label });
      card.createDiv({ cls: "vcc-card-value", text: c.value });
    }

    // ---- latest edit ----
    this.latestEl.empty();
    if (m.newest) {
      this.latestEl.createDiv({ cls: "vcc-latest-label", text: "Latest edit" });
      const row = this.latestEl.createDiv({ cls: "vcc-latest-row" });
      const name = row.createDiv({ cls: "vcc-latest-name", text: m.newest.basename });
      name.addEventListener("click", () => this.app.workspace.openLinkText(m.newest.path, "", false));
      row.createDiv({ cls: "vcc-latest-age", text: relativeAge(m.newest.stat.mtime) });
      const parent = m.newest.parent && m.newest.parent.path;
      this.latestEl.createDiv({
        cls: "vcc-latest-path",
        text: parent && parent !== "/" ? parent : "vault root",
      });
    }
  }

  // ---- Layout --------------------------------------------------------------

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("vcc-container");

    const header = root.createDiv({ cls: "vcc-header" });
    header.createSpan({ cls: "vcc-rule" });
    header.createDiv({ cls: "vcc-title", text: "Vault Command Center" });
    const refresh = header.createEl("button", { cls: "vcc-refresh", text: "↻" });
    refresh.setAttribute("aria-label", "Recompute metrics");
    refresh.addEventListener("click", () => this.renderMetrics());

    // The hero panel and the card row are the two things that re-render on every
    // index change, so they get stable containers rather than being rebuilt.
    this.metricsEl = root.createDiv({ cls: "vcc-metrics" });
    this.gaugeEl = this.metricsEl.createDiv({ cls: "vcc-gauge vcc-framed" });
    this.cardsEl = this.metricsEl.createDiv({ cls: "vcc-cards" });
    this.latestEl = this.metricsEl.createDiv({ cls: "vcc-latest vcc-framed" });
    this.renderMetrics();

    root.createDiv({ cls: "vcc-section-label", text: "Actions" });
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
    this.statusEl = outHeader.createSpan({ cls: "vcc-run-status" });
    this.cancelBtn = outHeader.createEl("button", { cls: "vcc-cancel", text: "Cancel" });
    this.cancelBtn.hide();
    this.cancelBtn.addEventListener("click", () => this.cancel());
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

  // ---- Output ----------------------------------------------------------------
  // Text arrives token by token, so each kind of content gets its own span rather
  // than one growing string - that keeps thinking visually distinct from the
  // answer without re-rendering the whole transcript on every delta.

  append(cls, text) {
    const atBottom =
      this.outEl.scrollHeight - this.outEl.scrollTop - this.outEl.clientHeight < 40;

    if (cls === "vcc-out-text" && this.lastTextEl) {
      this.lastTextEl.setText(this.lastTextEl.getText() + text);
    } else {
      const span = this.outEl.createSpan({ cls, text });
      this.lastTextEl = cls === "vcc-out-text" ? span : null;
    }

    // Only follow the tail if the reader was already at it; otherwise scrolling
    // back to re-read something would be yanked away on the next token.
    if (atBottom) this.outEl.scrollTop = this.outEl.scrollHeight;
  }

  // ---- Execution -------------------------------------------------------------

  renderEvent(event) {
    switch (event.kind) {
      case "text":
        return this.append("vcc-out-text", event.text);
      case "thinking":
        return this.append("vcc-out-thinking", event.text);
      case "tool":
        return this.append("vcc-out-tool", `\n⚙ ${event.text}\n`);
      case "raw":
        return this.append("vcc-out-raw", event.text + "\n");
      case "status":
        return this.statusEl && this.statusEl.setText(event.text);
      case "result":
        return this.append(
          event.ok ? "vcc-out-done" : "vcc-out-fail",
          `\n\n— ${event.ok ? "done" : "error"} in ${(event.durationMs / 1000).toFixed(1)}s` +
            (typeof event.costUsd === "number" ? ` · $${event.costUsd.toFixed(4)}` : "") +
            "\n"
        );
    }
  }

  cancel() {
    if (!this.child) return;
    this.cancelled = true;
    killTree(this.child);
    this.append("vcc-out-fail", "\n— cancelled —\n");
  }

  run(action) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Vault Command Center requires a local vault.");
      return;
    }
    const cwd = adapter.getBasePath();
    const args = buildArgs(action);

    this.setBusy(true);
    this.cancelled = false;
    this.lastTextEl = null;
    this.sawOutput = false;
    this.outTitle.setText(`Output — ${action.label}`);
    this.outEl.empty();
    this.append("vcc-out-cmd", `$ claude ${args.join(" ")}\n\n`);

    const started = Date.now();
    let child;
    try {
      // stdin must be closed, not inherited: `claude -p` waits ~3s for piped input
      // before giving up, which shows as a stderr warning and delays every run.
      child = spawn("claude", args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      this.fail(`could not start claude: ${e.message}`, action);
      return;
    }
    this.child = child;

    this.timedOut = false;
    const timer = setTimeout(() => {
      this.timedOut = true;
      killTree(child);
    }, RUN_TIMEOUT_MS);

    // stdout is NDJSON, but a chunk boundary can land mid-line, so hold the tail
    // until its newline arrives rather than handing a half object to the parser.
    let tail = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (tail + chunk).split("\n");
      tail = lines.pop();
      for (const line of lines) {
        const event = routeLine(line);
        if (!event) continue;
        if (event.kind !== "status") this.sawOutput = true;
        this.renderEvent(event);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.append("vcc-out-raw", chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      this.child = null;
      const hint =
        err.code === "ENOENT"
          ? "\n'claude' was not found on PATH. Obsidian inherits the PATH it was " +
            "launched with - if you changed PATH after starting Obsidian, restart it."
          : "";
      this.fail(`${err.message}${hint}`, action);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      this.child = null;
      if (tail) {
        const event = routeLine(tail);
        if (event) this.renderEvent(event);
      }

      const secs = ((Date.now() - started) / 1000).toFixed(1);

      if (this.cancelled) {
        new Notice(`${action.label}: cancelled`);
      } else if (this.timedOut) {
        this.fail(`run exceeded ${RUN_TIMEOUT_MS / 1000}s and was terminated`, action);
      } else if (code !== 0) {
        this.fail(`claude exited with code ${code} after ${secs}s`, action);
      } else if (!this.sawOutput) {
        // A clean exit with nothing to show is not a success worth announcing.
        this.append(
          "vcc-out-fail",
          `\n— finished in ${secs}s with no output.\n\n` +
            "Nothing came back on the stream. If this action was meant to change " +
            "files, it did nothing.\n"
        );
        new Notice(`${action.label}: no output`);
      } else {
        new Notice(`${action.label}: done`);
      }

      if (this.statusEl) this.statusEl.setText("");
      this.setBusy(false);
      this.renderMetrics();
    });
  }

  fail(message, action) {
    this.append("vcc-out-fail", `\n— failed: ${message}\n`);
    new Notice(`${action.label}: failed`);
    if (this.statusEl) this.statusEl.setText("");
    this.setBusy(false);
  }
}

// child.kill() signals only the shim on Windows; claude.exe survives it and keeps
// running (and billing). taskkill /T ends the tree.
function killTree(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
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
        ? "Runs with --permission-mode acceptEdits: Claude may create and edit files " +
          "in this vault without asking again. Shell commands are still refused."
        : "Runs with permission prompts denied: nothing in the vault can be modified.",
    });
    contentEl.createEl("p", { text: "Command:" });
    contentEl.createEl("pre", {
      cls: "vcc-modal-prompt",
      // The exact argv, so the permission mode is visible before it is agreed to.
      text: "claude " + buildArgs(this.action).join(" "),
    });

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

// Exposed for tests; the plugin itself never reads this.
module.exports.__test = { routeLine, buildArgs, sectionExists, sectionHasBody };
