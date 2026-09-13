import { spawn } from "node:child_process";
import { isIP } from "node:net";
import type { MagicBuilderRunner } from "./types";

export type MagicBuilderErrorCode =
  | "MIAOBI_CLI_FAILED"
  | "MIAOBI_AUTH_REQUIRED"
  | "MIAOBI_INVALID_RESPONSE";

export class MagicBuilderError extends Error {
  readonly code: MagicBuilderErrorCode;

  constructor(code: MagicBuilderErrorCode) {
    super(code);
    this.name = "MagicBuilderError";
    this.code = code;
  }
}

export interface MagicBuilderRunnerOptions {
  command?: string;
  authEnv?: Readonly<{
    MAGIC_TOKEN?: string;
    MAGIC_BASE_URL?: string;
  }>;
}

function minimalSpawnEnv(
  authEnv: MagicBuilderRunnerOptions["authEnv"] = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (authEnv.MAGIC_TOKEN !== undefined) env.MAGIC_TOKEN = authEnv.MAGIC_TOKEN;
  if (authEnv.MAGIC_BASE_URL !== undefined) {
    env.MAGIC_BASE_URL = authEnv.MAGIC_BASE_URL;
  }
  return env;
}

const DEFAULT_MAGIC_PLATFORM_ORIGIN = "https://magic.solutionsuite.cn";

function isPrivateAddress(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/g, "");
  if (isIP(unwrapped) === 6) {
    const normalized = unwrapped.toLowerCase();
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized);
  }
  const parts = unwrapped.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

export function resolveMagicPlatformOrigin(value?: string): string {
  try {
    const url = new URL(value ?? DEFAULT_MAGIC_PLATFORM_ORIGIN);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.port ||
      hostname === "localhost" || isPrivateAddress(hostname) ||
      hostname === "workers.dev" || hostname.endsWith(".workers.dev")
    ) throw new Error();
    return url.origin;
  } catch {
    const error = new Error("MIAOBI_PLATFORM_ORIGIN_INVALID") as Error & { code: string };
    error.code = "MIAOBI_PLATFORM_ORIGIN_INVALID";
    throw error;
  }
}

export function createMagicBuilderRunner(
  options: MagicBuilderRunnerOptions = {},
): MagicBuilderRunner {
  const command = options.command ?? "magic-builder";
  const platformOrigin = resolveMagicPlatformOrigin(options.authEnv?.MAGIC_BASE_URL);
  return {
    platformOrigin,
    run(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          env: minimalSpawnEnv({
            ...options.authEnv,
            MAGIC_BASE_URL: platformOrigin,
          }),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", () => reject(new MagicBuilderError("MIAOBI_CLI_FAILED")));
        child.once("close", (code) => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const errorCode = /(?:auth|login|credential|unauthorized)/i.test(
            `${stdout}\n${stderr}`,
          )
            ? "MIAOBI_AUTH_REQUIRED"
            : "MIAOBI_CLI_FAILED";
          reject(new MagicBuilderError(errorCode));
        });
      });
    },
  };
}

function parseSingleJsonObject(output: string): unknown {
  const normalized = output.replace(/^\uFEFF/, "").trimStart();
  if (!normalized.startsWith("{")) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      const tail = normalized.slice(index + 1).trim();
      if (
        /[{}\[\]]/.test(tail) ||
        /^(?:"|-?\d|true\b|false\b|null\b)/.test(tail)
      ) {
        throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
      }
      const failureStatus = tail.replace(/\b0\s+errors?\b/gi, "");
      if (/(?:fail(?:ed|ure)?|error|denied|unauthori[sz]ed)/i.test(failureStatus)) {
        throw new MagicBuilderError("MIAOBI_CLI_FAILED");
      }
      try {
        return JSON.parse(normalized.slice(0, index + 1));
      } catch {
        throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
      }
    }
  }
  throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
}

export async function runMagicBuilderObject(
  runner: MagicBuilderRunner,
  args: string[],
): Promise<unknown> {
  let result: { stdout: string; stderr: string };
  try {
    result = await runner.run(args);
  } catch (error) {
    if (error instanceof MagicBuilderError) throw error;
    throw new MagicBuilderError("MIAOBI_CLI_FAILED");
  }
  return parseSingleJsonObject(result.stdout);
}

export async function runMagicBuilderJson(
  runner: MagicBuilderRunner,
  args: string[],
): Promise<{ id: string; url: string }> {
  const parsed = await runMagicBuilderObject(runner, args);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { url?: unknown }).url !== "string"
  ) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  return {
    id: (parsed as { id: string }).id,
    url: (parsed as { url: string }).url,
  };
}

export type { MagicBuilderRunner } from "./types";
