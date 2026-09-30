# Cleanup — Palimpsest

What this repo leaves behind while you work on it, and how to put the working tree
back to what a fresh `git clone` gives you. Companion to the `.gitignore` coverage
added in #1.

Nothing here touches files git tracks. `main.js`, `package-lock.json`, `src/`,
`test/`, `styles.css` and the docs all stay — **including every `.palimpsest` log
and marked-up PDF, which live in your vaults anyway and are not this repo's to
delete.**

## What this project leaves behind

| path / thing | created by | size note |
|---|---|---|
| `node_modules/` | `npm install` / `npm ci` | ~40–80 MB — esbuild, typescript, `obsidian` typings |
| `.testbuild/` | `npm test` — esbuild `--outdir=.testbuild` bundles 7 modules for `node --test` | ~1 MB, rebuilt every run |
| `graphify-out/` | `graphify update .` in this folder | grows with the repo being graphed |
| `/*— *.md` | the encrypted project note that lives in this folder | one file, **never delete it from a cleanup** |
| `.env`, `.env.*` | you, by hand (`OBSIDIAN_VAULT`, `OBSIDIAN_VAULTS`) | tiny — **kept on purpose**, see Secrets |
| `*.log`, `logs/` | redirected output from `npm test` or the build | safe to drop |
| `.tsbuildinfo`, `coverage/` | `tsc --incremental` or a coverage run if you add one | `npm run check` is `tsc --noEmit`, so neither today |
| `.venv/`, `__pycache__/` | only if a Python helper is added | none exists now |
| `.DS_Store`, `.idea/`, `.vscode/`, `*.swp` | Finder / editors | tiny |

`main.js` is **not** ignored: it is committed on purpose — Obsidian loads it straight
off disk, so a user installs by copying three files and never runs `npm install`.

## Preview

Lists every ignored file the clean below would remove, keeping your secrets:

```bash
git clean -ndX -e '!.env' -e '!.env.*' -e '!/*— *.md'
```

## Clean the repo

```bash
git clean -fdX -e '!.env' -e '!.env.*' -e '!/*— *.md'
```

That is everything `git clean` can see. What it **cannot** see — all outside the
repo, all manual:

**1 — the vault plugin copies.** `npm run install-local` copies `main.js`,
`manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/palimpsest/` for the
umbrella folder and the BlackRock, Berkshire and Citadel vaults, and for BlackRock it
also adds `"palimpsest"` to `.obsidian/community-plugins.json`:

```bash
for v in "" /BlackRock /Berkshire /Citadel; do
  rm -rf ~/Documents"$v"/.obsidian/plugins/palimpsest
done
```

Then remove the `"palimpsest"` entry from BlackRock's `community-plugins.json` by
hand if the plugin was auto-enabled (leave every other entry alone), and reload
Obsidian.

**2 — your markup.** The plugin writes `.palimpsest` logs beside PDFs and companion
`<name>.md` notes **inside the vaults**, on your marks. **Nothing in this file
touches them.** They are your work, not build output; delete individual ones from
inside Obsidian if you mean to.

After a clean, restore dependencies with `npm ci`, then `npm test` and
`npm run build` to regenerate `.testbuild/` and `main.js`.

## Outside the repo

| thing | exact command | shared? |
|---|---|---|
| npm's download cache, filled by `npm ci` | `npm cache clean --force` | **shared — every Node project on this Mac uses it.** Only worth it for the disk; it costs a re-download next time. |
| `<vault>/.obsidian/plugins/palimpsest/` + the BlackRock `community-plugins.json` entry | the `for` loop above, then edit the JSON by hand | per-vault, manual, optional — lives in `~/Documents`. |
| `.palimpsest` logs and companion notes in vaults | delete per file inside Obsidian | **never automated** — these are the documents. |

Nothing else. No pip packages, no model weights, no Playwright browsers (the plugin
borrows Obsidian's own bundled pdf.js rather than downloading one), no Docker images,
no launchd plists: `npm test` writes `.testbuild/` and nothing more, and the tests
create no temp files.

## Secrets

`.env`, `.env.*`, `*.key`, `*.pem`, `credentials.json` and `secrets.json` are ignored
**and deliberately kept** by both commands above — the `-e '!.env' -e '!.env.*'`
exceptions mean `git clean` skips them. Your local secrets survive a cleanup.

There is no secret in this project today: nothing here reads an API key, and the
markup never leaves the machine. If you ever add one, it belongs in `.env`, not in
`src/`.

If you truly mean to get rid of a secret file, remove it yourself and mean it:

```bash
rm -f .env .env.*
```

If a secret was ever *committed*, deleting the file is not enough — it is in history.
Open an issue and rotate the credential first; never rewrite published history.
