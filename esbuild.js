// Bundles the extension with esbuild. `vscode` is provided by the host and must
// stay external; everything else is bundled into dist/extension.js. A one-shot
// build also writes dist/source.zip (the full source) so the .vsix is
// self-contained for the white-label "Full source" export.
const esbuild = require("esbuild");
const path = require("node:path");
const { bundleSource } = require("./scripts/bundle-source");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: "dist/extension.js",
    external: [
      "vscode",
      // Optional native/cloud add-ons probed via try/require by pg & mongodb;
      // never installed (pure-JS posture, ADR-0016) so they must stay external.
      "pg-native",
      "kerberos",
      "@mongodb-js/zstd",
      "@aws-sdk/credential-providers",
      "gcp-metadata",
      "snappy",
      "socks",
      "aws4",
      "mongodb-client-encryption",
    ],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    // Self-contained .vsix: ship the full source as dist/source.zip so it can be
    // maintained without the original repo (node_modules excluded — restored via
    // npm). Skipped under --watch (only needed in a packaged build).
    const bytes = bundleSource(path.join(__dirname));
    console.log(`  dist/source.zip ${Math.round(bytes / 1024)} KB (full source for white-label export)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
