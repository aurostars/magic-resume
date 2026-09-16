import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { MIAOBI_ASSET_BASE_PLACEHOLDER } from "../../vite.miaobi.config";
export { injectMiaobiRuntime } from "../../miaobi/runtime-config";

const REWRITABLE_BUILD_EXTENSIONS = new Set([".css", ".html", ".js", ".mjs"]);

async function filesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function rewritePublicAssetReferences(
  text: string,
  publicDirectories: string[],
  assetBasePlaceholder: string,
): string {
  let rewritten = text;
  for (const directory of publicDirectories) {
    const escapedDirectory = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const resourcePath = `(?:\\.\\./|\\./|/)${escapedDirectory}/`;
    const boundaries = [
      new RegExp(`(\\burl\\(\\s*["']?)${resourcePath}`, "g"),
      new RegExp(`(\\b(?:src|href|poster)\\s*=\\s*["'])${resourcePath}`, "g"),
    ];
    for (const boundary of boundaries) {
      rewritten = rewritten.replace(boundary, `$1${assetBasePlaceholder}${directory}/`);
    }
  }
  return rewritten;
}

function rewriteRootPublicDirectoryReferences(
  text: string,
  publicDirectories: string[],
  assetBasePlaceholder: string,
): string {
  let rewritten = text;
  for (const directory of publicDirectories) {
    const escapedDirectory = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = new RegExp(
      `((?:(?:\\b[$\\w]+|["'][^"']+["'])\\s*:|\\bnew URL\\()\\s*["'])\\/${escapedDirectory}/`,
      "g",
    );
    rewritten = rewritten.replace(
      boundary,
      `$1${assetBasePlaceholder}${directory}/`,
    );
  }
  return rewritten;
}

function rewriteKnownPublicAssetLiterals(
  text: string,
  publicPaths: string[],
  assetBasePlaceholder: string,
): string {
  let rewritten = text;
  for (const publicPath of publicPaths) {
    const escapedPath = publicPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rewritten = rewritten.replace(
      new RegExp(`(["'])\\/${escapedPath}(?=[?#]|\\1)`, "g"),
      (literal, quote: string, offset: number, source: string) => {
        const prefix = source.slice(0, offset);
        if (/(?:^|[;{}])\s*(?:const|let|var)\s+[$\w]+\s*=\s*$/.test(prefix)) {
          return literal;
        }
        return `${quote}${assetBasePlaceholder}${publicPath}`;
      },
    );
  }
  return rewritten;
}

export async function rewriteBuiltAssetReferences(
  clientDirectory: string,
  assetBasePlaceholder: string,
): Promise<void> {
  const files = await filesRecursively(clientDirectory);
  const publicPaths = files
    .map((path) => relative(clientDirectory, path).split(sep).join("/"))
    .filter((path) => path !== "index.html" && path !== "_shell.html" && !path.startsWith("assets/"))
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));

  const publicDirectories = [...new Set(
    publicPaths.filter((path) => path.includes("/")).map((path) => path.split("/", 1)[0]),
  )].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  for (const path of files) {
    if (!REWRITABLE_BUILD_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    let text = await readFile(path, "utf8");
    text = text.replace(
      /(?:\/\.\/|\.\/|\/)assets\//g,
      `${assetBasePlaceholder}assets/`,
    );
    text = rewritePublicAssetReferences(
      text,
      publicDirectories,
      assetBasePlaceholder,
    );
    text = rewriteRootPublicDirectoryReferences(
      text,
      publicDirectories,
      assetBasePlaceholder,
    );
    text = rewriteKnownPublicAssetLiterals(
      text,
      publicPaths,
      assetBasePlaceholder,
    );
    await writeFile(path, text, "utf8");
  }
}

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
    await writeFile(stagedShellPath, shell, "utf8");
    await rm(generatedShellPath);
    await rewriteBuiltAssetReferences(stagedClientDirectory, input.assetBasePlaceholder);
    await replaceDirectory(stagedClientDirectory, outputDirectory);
    return {
      shellPath,
      assetDirectory: outputDirectory,
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
