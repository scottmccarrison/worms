import { mkdir, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "..", "dist");
const distIndex = join(distDir, "index.html");

export async function setup() {
  try {
    await access(distIndex);
    // Already built - leave it.
  } catch {
    await mkdir(distDir, { recursive: true });
    await writeFile(distIndex, "<!doctype html><title>worms test stub</title>");
  }
}
