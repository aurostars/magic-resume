import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { MIAOBI_ASSET_BASE_PLACEHOLDER } from "../../vite.miaobi.config";
export { injectMiaobiRuntime } from "../../miaobi/runtime-config";

export async function replaceDirectory(
  stagedDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const backupDirectory = `${outputDirectory}.backup-${randomUUID()}`;
  let hasBackup = false;

  try {
    await rename(outputDirectory, backupDirectory);
    hasBackup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await rename(stagedDirectory, outputDirectory);
  } catch (error) {
    if (hasBackup) {
      await rename(backupDirectory, outputDirectory);
    }
    throw error;
  }

  if (hasBackup) {
    await rm(backupDirectory, { recursive: true, force: true });
  }
}

export async function buildMiaobiSpa(input: {
  outputDirectory: string;
  assetBasePlaceholder: string;
}): Promise<{ shellPath: string; assetDirectory: string }> {
  if (input.assetBasePlaceholder !== MIAOBI_ASSET_BASE_PLACEHOLDER) {
    throw new Error("Unexpected Miaobi asset base placeholder");
  }

  const outputDirectory = resolve(input.outputDirectory);
  const outputParentDirectory = dirname(outputDirectory);
  await mkdir(outputParentDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(outputParentDirectory, ".miaobi-build-"),
  );
  await symlink(
    resolve("node_modules"),
    join(temporaryDirectory, "node_modules"),
    "dir",
  );
  const stagedClientDirectory = join(temporaryDirectory, "client");
  const generatedShellPath = join(stagedClientDirectory, "_shell.html");
  const stagedShellPath = join(stagedClientDirectory, "index.html");
  const shellPath = join(outputDirectory, "index.html");

  const previousBuildRoot = process.env.MAGIC_RESUME_MIAOBI_BUILD_ROOT;
  process.env.MAGIC_RESUME_MIAOBI_BUILD_ROOT = temporaryDirectory;

  try {
    const builder = await createBuilder({
      configFile: resolve("vite.miaobi.config.ts"),
    });
    await builder.buildApp();

    const shell = await readFile(generatedShellPath, "utf8");
    await writeFile(
      stagedShellPath,
      shell.replaceAll("/assets/", input.assetBasePlaceholder),
      "utf8",
    );
    await rm(generatedShellPath);
    await replaceDirectory(stagedClientDirectory, outputDirectory);
    return {
      shellPath,
      assetDirectory: join(outputDirectory, "assets"),
    };
  } finally {
    if (previousBuildRoot === undefined) {
      delete process.env.MAGIC_RESUME_MIAOBI_BUILD_ROOT;
    } else {
      process.env.MAGIC_RESUME_MIAOBI_BUILD_ROOT = previousBuildRoot;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const outputDirectory = resolve("dist/miaobi/client");
  void buildMiaobiSpa({
    outputDirectory,
    assetBasePlaceholder: MIAOBI_ASSET_BASE_PLACEHOLDER,
  })
    .then((result) => process.stdout.write(`${result.shellPath}\n`))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
