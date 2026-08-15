import { findChromeZip, scanProductionZip } from "./production-scan";

async function main(): Promise<void> {
  const zipPath = await findChromeZip();
  const scan = await scanProductionZip(zipPath);
  if (!scan.ok) {
    process.stderr.write(
      `Production zip scan failed for ${zipPath}:\n${scan.errors.join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Production zip scan ok: ${zipPath}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
