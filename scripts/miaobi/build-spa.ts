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

const REWRITABLE_BUILD_EXTENSIONS = new Set([".css", ".html"]);

async function filesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ResourceSyntax = "css" | "html";

function rewriteDirectoryReferences(
  text: string,
  directories: string[],
  assetBasePlaceholder: string,
  syntax: ResourceSyntax,
): string {
  let rewritten = text;
  for (const directory of directories) {
    const resourcePath = `(?:\\.\\./|\\./|/\\./|/)${escapeRegularExpression(directory)}/`;
    const boundary = syntax === "css"
      ? new RegExp(`(\\burl\\(\\s*["']?)${resourcePath}`, "g")
      : new RegExp(`(\\b(?:src|href|poster)\\s*=\\s*["'])${resourcePath}`, "g");
    rewritten = rewritten.replace(boundary, `$1${assetBasePlaceholder}${directory}/`);
  }
  return rewritten;
}

function rewritePublicFileReferences(
  text: string,
  publicPaths: string[],
  assetBasePlaceholder: string,
  syntax: ResourceSyntax,
): string {
  let rewritten = text;
  for (const publicPath of publicPaths) {
    const escapedPath = escapeRegularExpression(publicPath);
    const boundary = syntax === "css"
      ? new RegExp(`(\\burl\\(\\s*["']?)\\/${escapedPath}(?=[?#"')])`, "g")
      : new RegExp(`(\\b(?:src|href|poster)\\s*=\\s*["'])\\/${escapedPath}(?=[?#"'])`, "g");
    rewritten = rewritten.replace(boundary, `$1${assetBasePlaceholder}${publicPath}`);
  }
  return rewritten;
}

export function rewritePublicAssetReferences(
  text: string,
  publicDirectories: string[],
  assetBasePlaceholder: string,
): string {
  return rewriteDirectoryReferences(
    rewriteDirectoryReferences(text, publicDirectories, assetBasePlaceholder, "css"),
    publicDirectories,
    assetBasePlaceholder,
    "html",
  );
}

function rewriteCssAssetReferences(
  text: string,
  directories: string[],
  publicPaths: string[],
  assetBasePlaceholder: string,
): string {
  return rewritePublicFileReferences(
    rewriteDirectoryReferences(text, directories, assetBasePlaceholder, "css"),
    publicPaths,
    assetBasePlaceholder,
    "css",
  );
}

function rewriteAssetReferenceValue(
  value: string,
  directories: string[],
  assetBasePlaceholder: string,
): string {
  for (const directory of directories) {
    const resourcePath = new RegExp(
      `^(?:\\.\\./|\\./|/\\./|/)${escapeRegularExpression(directory)}/`,
    );
    if (resourcePath.test(value)) {
      return value.replace(resourcePath, `${assetBasePlaceholder}${directory}/`);
    }
  }
  return value;
}

function rewriteSerializedRouterManifest(
  script: string,
  directories: string[],
  assetBasePlaceholder: string,
): string {
  const rewriteValue = (value: string) =>
    rewriteAssetReferenceValue(value, directories, assetBasePlaceholder);

  return script
    .replace(
      /(preloads:\$R\[\d+\]=\[)([^\]]*)(\])/g,
      (_, prefix: string, values: string, suffix: string) =>
        `${prefix}${values.replace(/"([^"\\]*)"/g, (_literal, value: string) => `"${rewriteValue(value)}"`)}${suffix}`,
    )
    .replace(
      /(tag:"link",attrs:\$R\[\d+\]=\{[^}]*?\bhref:")([^"\\]+)(")/g,
      (_, prefix: string, value: string, suffix: string) =>
        `${prefix}${rewriteValue(value)}${suffix}`,
    )
    .replace(
      /(tag:"script",attrs:\$R\[\d+\]=\{[^}]*\},children:"import\(\\")([^"\\]+)(\\"\)")/g,
      (_, prefix: string, value: string, suffix: string) =>
        `${prefix}${rewriteValue(value)}${suffix}`,
    );
}

function rewriteStandaloneModuleImport(
  script: string,
  directories: string[],
  assetBasePlaceholder: string,
): string {
  let rewritten = script;
  for (const directory of directories) {
    const resourcePath = `(?:\\.\\./|\\./|/\\./|/)${escapeRegularExpression(directory)}/`;
    rewritten = rewritten.replace(
      new RegExp(`^(\\s*import\\(\\s*["'])${resourcePath}([^"']+["']\\s*\\)\\s*;?\\s*)$`),
      `$1${assetBasePlaceholder}${directory}/$2`,
    );
  }
  return rewritten;
}

function rewriteHtmlAssetReferences(
  text: string,
  directories: string[],
  publicPaths: string[],
  assetBasePlaceholder: string,
): string {
  return text.replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]+>/gi,
    (token) => {
      if (/^<!--/.test(token)) return token;
      if (/^<script\b/i.test(token)) {
        return token.replace(
          /^(<script\b[^>]*>)([\s\S]*)(<\/script\s*>)$/i,
          (_, openingTag: string, script: string, closingTag: string) => {
            const rewrittenOpeningTag = rewritePublicFileReferences(
              rewriteDirectoryReferences(openingTag, directories, assetBasePlaceholder, "html"),
              publicPaths,
              assetBasePlaceholder,
              "html",
            );
            const routerManifestScript = /\bid\s*=\s*["']\$tsr-stream-barrier["']/i.test(openingTag)
              ? rewriteSerializedRouterManifest(script, directories, assetBasePlaceholder)
              : script;
            const rewrittenScript = /\btype\s*=\s*["']module["']/i.test(openingTag)
              ? rewriteStandaloneModuleImport(
                routerManifestScript,
                directories,
                assetBasePlaceholder,
              )
              : routerManifestScript;
            return `${rewrittenOpeningTag}${rewrittenScript}${closingTag}`;
          },
        );
      }
      if (/^<style\b/i.test(token)) {
        return token.replace(
          /^(<style\b[^>]*>)([\s\S]*)(<\/style\s*>)$/i,
          (_, openingTag: string, css: string, closingTag: string) =>
            `${openingTag}${rewriteCssAssetReferences(css, directories, publicPaths, assetBasePlaceholder)}${closingTag}`,
        );
      }
      return rewritePublicFileReferences(
        rewriteDirectoryReferences(token, directories, assetBasePlaceholder, "html"),
        publicPaths,
        assetBasePlaceholder,
        "html",
      );
    },
  );
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

  const assetDirectories = ["assets", ...publicDirectories];

  for (const path of files) {
    const extension = extname(path).toLowerCase();
    if (!REWRITABLE_BUILD_EXTENSIONS.has(extension)) continue;
    const text = await readFile(path, "utf8");
    const rewritten = extension === ".css"
      ? rewriteCssAssetReferences(
        text,
        assetDirectories,
        publicPaths,
        assetBasePlaceholder,
      )
      : rewriteHtmlAssetReferences(
        text,
        assetDirectories,
        publicPaths,
        assetBasePlaceholder,
      );
    await writeFile(path, rewritten, "utf8");
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
