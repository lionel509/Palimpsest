import esbuild from "esbuild";
import builtins from "builtin-modules";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian supplies these at runtime; bundling them would break the plugin.
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2022",
  platform: "node",
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: "main.js",
  minify: false,
});
