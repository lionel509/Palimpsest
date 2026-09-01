/** Copy the built plugin into the vaults that hold PDFs worth marking up.
 *
 *  Vanguard is deliberately absent and must stay that way — it is off-limits.
 */
import { copyFile, mkdir, access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Override with OBSIDIAN_VAULT (umbrella folder) or OBSIDIAN_VAULTS
 *  (colon-separated list of vault paths, replacing the list entirely). */
const DOCS = process.env.OBSIDIAN_VAULT ?? "/Users/lionelweng/Documents";

const VAULTS = process.env.OBSIDIAN_VAULTS
  ? process.env.OBSIDIAN_VAULTS.split(":").filter(Boolean)
  : [
      DOCS,                 // umbrella — every sub-vault is visible from here
      `${DOCS}/BlackRock`,  // lecture slides: the reason this plugin exists
      `${DOCS}/Berkshire`,  // vendor sheets and spec PDFs
      `${DOCS}/Citadel`,    // datasheets
    ];

/** Vaults where the plugin is switched on for you. Elsewhere, enable it by hand. */
const ENABLE_IN = new Set([`${DOCS}/BlackRock`]);

for (const vault of VAULTS) {
  const target = join(vault, ".obsidian/plugins/palimpsest");
  try {
    await access(join(vault, ".obsidian"));
  } catch {
    console.log(`skipped ${vault} — not an Obsidian vault`);
    continue;
  }
  await mkdir(target, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(file, join(target, file));
  }
  console.log(`installed -> ${target}`);

  if (!ENABLE_IN.has(vault)) continue;
  const listPath = join(vault, ".obsidian/community-plugins.json");
  try {
    const list = JSON.parse(await readFile(listPath, "utf8"));
    if (!list.includes("palimpsest")) {
      list.push("palimpsest");
      await writeFile(listPath, `${JSON.stringify(list, null, 2)}\n`);
      console.log(`  enabled in ${vault}`);
    }
  } catch {
    console.log(`  could not read ${listPath} — enable Palimpsest by hand`);
  }
}

console.log("\nReload each vault (Cmd-R), then check Settings -> Community plugins.");
