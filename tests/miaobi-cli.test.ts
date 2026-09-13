import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMagicBuilderRunner,
  runMagicBuilderJson,
} from "../scripts/miaobi/magic-builder";

const expectedResult = {
  id: "asset-123",
  url: "https://assets.example.test/releases/release.json",
};

test("parses a pure JSON upload response", async () => {
  const result = await runMagicBuilderJson(
    { run: async () => ({ stdout: JSON.stringify(expectedResult), stderr: "" }) },
    ["tos", "upload"],
  );

  assert.deepEqual(result, expectedResult);
});

test("rejects status text before the JSON object", async () => {
  await assert.rejects(
    runMagicBuilderJson(
      {
        run: async () => ({
          stdout: `Starting upload\n${JSON.stringify(expectedResult)}`,
          stderr: "",
        }),
      },
      ["file", "upload"],
    ),
    { code: "MIAOBI_INVALID_RESPONSE" },
  );
});

test("rejects a second structured value after the JSON object", async () => {
  for (const tail of [
    '{"status":"ok"}',
    '["extra"]',
    '"extra"',
    "true",
    "123",
  ]) {
    await assert.rejects(
      runMagicBuilderJson(
        {
          run: async () => ({
            stdout: `${JSON.stringify(expectedResult)}\n${tail}`,
            stderr: "",
          }),
        },
        ["file", "upload"],
      ),
      { code: "MIAOBI_INVALID_RESPONSE" },
    );
  }
});

test("rejects a failure status after an otherwise valid JSON object", async () => {
  await assert.rejects(
    runMagicBuilderJson(
      {
        run: async () => ({
          stdout: `${JSON.stringify(expectedResult)}\nUpload failed: denied`,
          stderr: "",
        }),
      },
      ["file", "upload"],
    ),
    { code: "MIAOBI_CLI_FAILED" },
  );
});

test("parses JSON before a human-readable status line", async () => {
  const result = await runMagicBuilderJson(
    {
      run: async () => ({
        stdout: `${JSON.stringify(expectedResult)}\nUpload completed successfully\n`,
        stderr: "",
      }),
    },
    ["tos", "upload"],
  );

  assert.deepEqual(result, expectedResult);
});

test("converts a non-zero CLI exit into a stable sanitized error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-builder-cli-"));
  const command = join(directory, "fake-magic-builder");
  await writeFile(
    command,
    "#!/bin/sh\nprintf '%s' 'token=super-secret raw failure' >&2\nexit 7\n",
  );
  await chmod(command, 0o700);

  try {
    const runner = createMagicBuilderRunner({ command });
    await assert.rejects(
      runner.run(["tos", "upload"]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "MIAOBI_CLI_FAILED");
        assert.doesNotMatch(String(error), /super-secret|token|raw failure/i);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps login failures on stdout to the stable auth-required code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-builder-auth-"));
  const command = join(directory, "fake-magic-builder");
  await writeFile(command, "#!/bin/sh\nprintf '%s' 'Please login first'\nexit 1\n");
  await chmod(command, 0o700);

  try {
    const runner = createMagicBuilderRunner({ command });
    await assert.rejects(runner.run([]), {
      code: "MIAOBI_AUTH_REQUIRED",
      message: "MIAOBI_AUTH_REQUIRED",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an upload response missing url", async () => {
  await assert.rejects(
    runMagicBuilderJson(
      { run: async () => ({ stdout: '{"id":"asset-123"}', stderr: "" }) },
      ["tos", "upload"],
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "MIAOBI_INVALID_RESPONSE",
  );
});

test("rejects an upload response missing id", async () => {
  await assert.rejects(
    runMagicBuilderJson(
      {
        run: async () => ({
          stdout: '{"url":"https://assets.example.test/file.js"}',
          stderr: "",
        }),
      },
      ["tos", "upload"],
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "MIAOBI_INVALID_RESPONSE",
  );
});

test("discards token-like fields from malformed response errors", async () => {
  await assert.rejects(
    runMagicBuilderJson(
      {
        run: async () => ({
          stdout: '{"access_token":"secret-value","status":"failed"}',
          stderr: "authorization: bearer secret-value",
        }),
      },
      ["tos", "upload"],
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "MIAOBI_INVALID_RESPONSE");
      assert.doesNotMatch(String(error), /secret-value|access_token|authorization|bearer/i);
      return true;
    },
  );
});

test("passes only minimal runtime variables plus explicitly injected auth env", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-builder-env-"));
  const command = join(directory, "fake-magic-builder");
  const previous = process.env.SECRET_SHOULD_NOT_LEAK;
  process.env.SECRET_SHOULD_NOT_LEAK = "host-secret";
  await writeFile(
    command,
    "#!/bin/sh\nprintf '{\"id\":\"%s:%s\",\"url\":\"https://assets.example.test/file\"}' \"${MAGIC_TOKEN-unset}\" \"${SECRET_SHOULD_NOT_LEAK-unset}\"\n",
  );
  await chmod(command, 0o700);

  try {
    const runner = createMagicBuilderRunner({
      command,
      authEnv: { MAGIC_TOKEN: "injected-token" },
    });
    const response = await runMagicBuilderJson(runner, []);
    assert.equal(response.id, "injected-token:unset");
  } finally {
    if (previous === undefined) delete process.env.SECRET_SHOULD_NOT_LEAK;
    else process.env.SECRET_SHOULD_NOT_LEAK = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes metacharacters as literal arguments without a shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-builder-argv-"));
  const command = join(directory, "fake-magic-builder");
  const injectedPath = join(directory, "injected");
  await writeFile(
    command,
    "#!/bin/sh\nprintf '{\"id\":\"%s\",\"url\":\"https://assets.example.test/file\"}' \"$1\"\n",
  );
  await chmod(command, 0o700);

  try {
    const runner = createMagicBuilderRunner({ command });
    const argument = `literal;touch ${injectedPath}`;
    const response = await runMagicBuilderJson(runner, [argument]);
    assert.equal(response.id, argument);
    await assert.rejects(
      import("node:fs/promises").then(({ access }) => access(injectedPath)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
