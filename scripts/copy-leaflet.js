const fs = require("fs/promises");
const path = require("path");

async function main() {
  const root = path.join(__dirname, "..");
  const srcDir = path.join(root, "node_modules", "leaflet", "dist");
  const destDir = path.join(root, "public", "vendor", "leaflet");

  await fs.mkdir(destDir, { recursive: true });
  await fs.cp(srcDir, destDir, { recursive: true });

  console.log(`[copy-leaflet] Copied Leaflet dist -> ${path.relative(root, destDir)}`);
}

main().catch((err) => {
  console.error("[copy-leaflet] Failed:", err);
  process.exit(1);
});
