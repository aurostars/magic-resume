import { spawn } from "node:child_process";

export interface GitCommandRunner {
  run(args: string[], options?: { cwd?: string; signal?: AbortSignal }): Promise<{
    stdout: string;
    stderr: string;
  }>;
}

export type CommandFailureKind = "not-found" | "non-fast-forward" | "other";

export class RedactedCommandError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly kind: CommandFailureKind;

  constructor(input: {
    command: "git" | "gh";
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    kind: CommandFailureKind;
  }) {
    super(`${input.command.toUpperCase()}_COMMAND_FAILED`);
    this.name = "RedactedCommandError";
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.kind = input.kind;
  }
}

function isRejectedPagesRef(stdout: string, args: string[]): boolean {
  if (args[0] !== "push" || !args.includes("--porcelain") || !args.includes("HEAD:gh-pages")) {
    return false;
  }
  return stdout.split(/\r?\n/).some((line) => {
    const fields = line.split("\t");
    if (fields.length < 3 || fields[0].trim() !== "!") return false;
    const ref = fields[1].trim();
    const summary = fields.slice(2).join("\t").trim();
    return (ref === "HEAD:gh-pages" || ref === "HEAD:refs/heads/gh-pages") &&
      /^\[rejected\] \((?:non-fast-forward|fetch first|stale info)\)$/.test(summary);
  });
}

function classifyFailure(stdout: string, stderr: string, args: string[]): CommandFailureKind {
  if (isRejectedPagesRef(stdout, args)) {
    return "non-fast-forward";
  }
  if (/HTTP 404|status code 404|not found|couldn't find remote ref|no such ref/i.test(stderr)) {
    return "not-found";
  }
  return "other";
}

function createCommandRunner(command: "git" | "gh"): GitCommandRunner {
  return {
    async run(args, options = {}) {
      if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
        throw new TypeError("MIAOBI_INVALID_COMMAND_ARGUMENTS");
      }
      return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          signal: options.signal,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", () => {
          reject(new RedactedCommandError({ command, exitCode: null, signal: null, kind: "other" }));
        });
        child.once("close", (exitCode, signal) => {
          const output = {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
          if (exitCode === 0) resolve(output);
          else reject(new RedactedCommandError({
            command,
            exitCode,
            signal,
            kind: classifyFailure(output.stdout, output.stderr, args),
          }));
        });
      });
    },
  };
}

export function createGitCommandRunner(): GitCommandRunner {
  return createCommandRunner("git");
}

export function createGitHubCliRunner(): GitCommandRunner {
  return createCommandRunner("gh");
}
