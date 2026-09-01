import { ItemView, Notice, Plugin, TFile, TFolder, View, WorkspaceLeaf } from "obsidian";
import { parseLog, replay } from "./log";
import { generate, merge } from "./note";
import { DEFAULT_SETTINGS, PalimpsestSettings, migrateSettings } from "./settings";
import { PalimpsestSettingTab } from "./settings-tab";
import { PALIMPSEST_EXT, PalimpsestView, VIEW_TYPE_PALIMPSEST } from "./view";

/** Obsidian's own view type for a PDF. */
const PDF_VIEW = "pdf";

export default class PalimpsestPlugin extends Plugin {
  settings: PalimpsestSettings = { ...DEFAULT_SETTINGS };

  /** PDF views we have already put a button on, so leaf changes don't stack them up. */
  private decorated = new WeakSet<View>();

  /** PDFs to leave alone for one open, because the user asked for the plain page. */
  private plainOnce = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_PALIMPSEST, (leaf) => new PalimpsestView(leaf, this));
    this.registerExtensions([PALIMPSEST_EXT], VIEW_TYPE_PALIMPSEST);
    this.addSettingTab(new PalimpsestSettingTab(this.app, this));

    this.addRibbonIcon("pen-line", "Palimpsest: mark up a PDF", () => void this.markUpActive());

    this.addCommand({
      id: "markup-active-pdf",
      name: "Mark up the current PDF",
      callback: () => void this.markUpActive(),
    });

    this.addCommand({
      id: "sync-note",
      name: "Sync the note for this PDF",
      callback: () => void this.syncNoteForActive(),
    });

    // The practice loop, from the command palette: you have finished going
    // through a page and want it back the way you found it, or you want to sit
    // the whole set again next week.
    this.addCommand({
      id: "cover-answers-again",
      name: "Cover the answers again",
      checkCallback: (checking) => {
        const view = this.activeMarkup();
        if (checking) return view !== null;
        view?.coverAgain();
        return true;
      },
    });

    this.addCommand({
      id: "clear-attempts",
      name: "Clear my attempts and start these again",
      checkCallback: (checking) => {
        const view = this.activeMarkup();
        if (checking) return view !== null;
        void view?.clearAttempts("all");
        return true;
      },
    });

    this.addCommand({
      id: "clear-wrong-attempts",
      name: "Clear the ones I got wrong and try them again",
      checkCallback: (checking) => {
        const view = this.activeMarkup();
        if (checking) return view !== null;
        void view?.clearAttempts("wrong");
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        menu.addItem((item) =>
          item
            .setTitle("Mark up with Palimpsest")
            .setIcon("pen-line")
            .onClick(() => void this.openMarkup(file)),
        );
      }),
    );

    // Put a pen button on the PDF viewer itself. Opening a PDF and looking for
    // a markup button is the obvious thing to do, so it has to be there.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.decoratePdfViews()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.decoratePdfViews()));
    this.app.workspace.onLayoutReady(() => this.decoratePdfViews());

    // A PDF you have already drawn on should open showing your drawing. Having
    // to remember which of two files holds your work is the un-user-friendly
    // version of this plugin.
    this.registerEvent(this.app.workspace.on("file-open", (file) => void this.maybeRedirect(file)));
  }

  onunload(): void {
    // Obsidian tears the leaves down; the view releases its PDF in onUnloadFile.
  }

  async loadSettings(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** The markup view in front of you, if that is what is in front of you. */
  private activeMarkup(): PalimpsestView | null {
    const view = this.app.workspace.getActiveViewOfType(PalimpsestView);
    return view ?? null;
  }

  /** Where a PDF's markup lives: the same name, beside it. */
  logPathFor(pdf: TFile): string {
    const folder = pdf.parent instanceof TFolder && pdf.parent.path !== "/" ? `${pdf.parent.path}/` : "";
    return `${folder}${pdf.basename}.${PALIMPSEST_EXT}`;
  }

  existingLogFor(pdf: TFile): TFile | null {
    const found = this.app.vault.getAbstractFileByPath(this.logPathFor(pdf));
    return found instanceof TFile ? found : null;
  }

  /** Let the plain PDF through once, when the user asked for it explicitly. */
  showPlainOnce(path: string): void {
    this.plainOnce.add(path);
  }

  private async maybeRedirect(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "pdf") return;

    if (this.plainOnce.has(file.path)) {
      this.plainOnce.delete(file.path);
      return;
    }

    const mode = this.settings.openMode;
    if (mode === "never") return;
    if (mode === "marked" && this.existingLogFor(file) === null) return;

    const leaf = this.app.workspace.getLeavesOfType(PDF_VIEW).find((candidate) => {
      const view = candidate.view as { file?: TFile | null };
      return view.file?.path === file.path;
    });
    if (!leaf) return;

    await this.openMarkup(file, leaf);
  }

  private async syncNoteForActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    let pdf: TFile | null = null;
    if (file.extension === "pdf") pdf = file;
    else if (file.extension === PALIMPSEST_EXT) pdf = await this.pdfForLog(file);

    if (!pdf) {
      new Notice("Palimpsest: open a PDF or its markup first.");
      return;
    }
    const note = await this.syncNote(pdf);
    if (note) await this.app.workspace.getLeaf(true).openFile(note);
  }

  /** The log's own header says which PDF it belongs to; the sibling of the same
   *  name is the fallback for a log whose PDF has been moved alongside it. */
  private async pdfForLog(log: TFile): Promise<TFile | null> {
    const header = parseLog(await this.app.vault.read(log)).header;
    if (header) {
      const stated = this.app.vault.getAbstractFileByPath(header.pdf);
      if (stated instanceof TFile) return stated;
    }
    const folder = log.parent && log.parent.path !== "/" ? `${log.parent.path}/` : "";
    const sibling = this.app.vault.getAbstractFileByPath(`${folder}${log.basename}.pdf`);
    return sibling instanceof TFile ? sibling : null;
  }

  /** Write the companion markdown note that puts this PDF in the graph.
   *
   *  Obsidian indexes tags and links out of markdown only, so a PDF cannot
   *  carry either by itself. Whatever was typed on the page is what lands here:
   *  `#tags` become frontmatter, `[[links]]` become real links. Nothing is
   *  invented, and prose written by hand in the note is left alone.
   */
  async syncNote(pdf: TFile): Promise<TFile | null> {
    const log = this.existingLogFor(pdf);
    if (!log) {
      new Notice("Palimpsest: nothing marked up on this PDF yet.");
      return null;
    }

    const parsed = parseLog(await this.app.vault.read(log));
    const pageCount = await this.pageCount(pdf);
    const state = replay(parsed.events, pageCount);

    const generated = generate({ pdfPath: pdf.path, title: pdf.basename, state });

    const path = `${pdf.parent && pdf.parent.path !== "/" ? `${pdf.parent.path}/` : ""}${pdf.basename}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      const merged = merge(await this.app.vault.read(existing), generated);
      await this.app.vault.modify(existing, merged);
      new Notice(`Palimpsest: updated ${existing.basename}`);
      return existing;
    }

    const created = await this.app.vault.create(path, merge(null, generated, ["pdf"]));
    new Notice(`Palimpsest: created ${created.basename}`);
    return created;
  }

  /** Page count without keeping the document open. */
  private async pageCount(pdf: TFile): Promise<number> {
    const { openPdf } = await import("./pdf");
    try {
      const doc = await openPdf(await this.app.vault.readBinary(pdf));
      const count = doc.numPages as number;
      doc.destroy?.();
      return count;
    } catch {
      return 0;
    }
  }

  /** Add "Mark up with Palimpsest" to every open PDF view that lacks it.
   *
   *  `addAction` is ItemView's public API — this adds a button to the tab's own
   *  action bar. It is not the same thing as reaching into Obsidian's PDF
   *  viewer internals, which this plugin deliberately does not do.
   */
  private decoratePdfViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW)) {
      const view = leaf.view;
      if (this.decorated.has(view)) continue;

      const asItem = view as ItemView;
      if (typeof asItem.addAction !== "function") continue;

      try {
        asItem.addAction("pen-line", "Mark up with Palimpsest", () => {
          const file = (view as { file?: TFile | null }).file;
          if (file instanceof TFile) void this.openMarkup(file, leaf);
        });
        this.decorated.add(view);
      } catch {
        /* a future Obsidian could rename the PDF view; the menu item still works */
      }
    }
  }

  private async markUpActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "pdf") {
      new Notice("Palimpsest: open a PDF first, then mark it up.");
      return;
    }
    await this.openMarkup(file, this.app.workspace.getMostRecentLeaf() ?? undefined);
  }

  /** Show a PDF ready to draw on.
   *
   *  The view opens **the PDF itself**, so the tab keeps the PDF's name and the
   *  file explorer highlights the PDF rather than a sidecar nobody thinks of as
   *  the document. Nothing is written here: the `<name>.palimpsest` log is
   *  created the first time an edit is actually made, which is what lets
   *  "open every PDF in Palimpsest" be a setting you can leave on without
   *  filling a course folder with empty logs.
   *
   *  The PDF itself is never touched — not on open, not on save, not ever.
   */
  async openMarkup(pdf: TFile, inPlaceOf?: WorkspaceLeaf): Promise<void> {
    // Reuse the PDF's own tab so the page appears to become markable in place,
    // rather than opening a second tab of the same document.
    const leaf = inPlaceOf && inPlaceOf.view.getViewType() === PDF_VIEW ? inPlaceOf : this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_PALIMPSEST, state: { file: pdf.path }, active: true });
  }
}
