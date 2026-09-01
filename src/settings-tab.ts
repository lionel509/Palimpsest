import { App, PluginSettingTab, Setting } from "obsidian";
import type PalimpsestPlugin from "./main";
import { OpenMode } from "./settings";

export class PalimpsestSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PalimpsestPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Open PDFs in Palimpsest")
      .setDesc(
        "Which PDFs open ready to draw on, instead of in Obsidian's own viewer. " +
          "Opening one here writes nothing — the markup file beside it is created the first time you actually mark something, " +
          "so this never litters a folder with empty logs.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("never", "Never — always use Obsidian's viewer")
          .addOption("marked", "Only ones I have already marked up")
          .addOption("always", "Every PDF")
          .setValue(this.plugin.settings.openMode)
          .onChange(async (value) => {
            this.plugin.settings.openMode = value as OpenMode;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The trade with “Every PDF” is text: Palimpsest paints pages to canvases, so Obsidian's text selection and outline are not available " +
        "(Palimpsest has its own search, with Cmd-F). The button in the tab's actions opens the plain PDF whenever you want those back.",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Markup is stored in a .palimpsest file beside each PDF. It is a plaintext log of your edits, " +
        "so your vault's git history versions the markup too. The PDF itself is never modified.",
    });
  }
}
