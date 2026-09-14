import { spawn } from "node:child_process";

export interface GitCommandRunner {
  run(args: string[], options?: { cwd?: string }): Promise<{
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

function classifyFailure(stderr: string): CommandFailureKind {
  if (/non-fast-forward|fetch first|failed to push some refs|stale info/i.test(stderr)) {
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
            kind: classifyFailure(output.stderr),
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
