import { spawn } from "node:child_process";
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

export function createMagicBuilderRunner(options: {
  command?: string;
} = {}): MagicBuilderRunner {
  const command = options.command ?? "magic-builder";
  return {
    run(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
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

function firstJsonObject(output: string): unknown {
  const start = output.indexOf("{");
  if (start < 0) throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(output.slice(start, index + 1));
      } catch {
        throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
      }
    }
  }
  throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
}

export async function runMagicBuilderJson(
  runner: MagicBuilderRunner,
  args: string[],
): Promise<{ id: string; url: string }> {
  let result: { stdout: string; stderr: string };
  try {
    result = await runner.run(args);
  } catch (error) {
    if (error instanceof MagicBuilderError) throw error;
    throw new MagicBuilderError("MIAOBI_CLI_FAILED");
  }

  const parsed = firstJsonObject(result.stdout);
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
