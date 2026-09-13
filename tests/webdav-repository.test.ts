import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import type {
  RemoteCollectionFile,
  RemotePrecondition,
  WebDavClientApi,
} from "../src/lib/webdav/client";
import { WebDavError } from "../src/lib/webdav/errors";
import { WebDavResumeRepository } from "../src/lib/webdav/repository";

type Call =
  | ["ensureDirectory", string]
  | ["getTextWithMetadata", string]
  | ["listCollection", string]
  | ["putText", string, string, RemotePrecondition | undefined]
  | ["move", string, string, RemotePrecondition | undefined]
  | ["delete", string];

class FakeClient implements WebDavClientApi {
  readonly calls: Call[] = [];
  readonly files = new Map<string, { text: string; etag: string | null }>();
  listing: RemoteCollectionFile[] = [];
  moveError: unknown = null;
  deleteError: unknown = null;

  async options(): Promise<void> {}
  async propfind(): Promise<boolean> { return true; }
  async ensureDirectory(path: string): Promise<void> {
    this.calls.push(["ensureDirectory", path]);
  }
  async getText(path: string): Promise<string | null> {
    return (await this.getTextWithMetadata(path))?.text ?? null;
  }
  async getTextWithMetadata(path: string): Promise<{ text: string; etag: string | null } | null> {
    this.calls.push(["getTextWithMetadata", path]);
    return this.files.get(path) ?? null;
  }
  async listCollection(path: string): Promise<RemoteCollectionFile[]> {
    this.calls.push(["listCollection", path]);
    return this.listing;
  }
  async putText(
    path: string,
    content: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
  ): Promise<void> {
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    this.calls.push(["putText", path, content, precondition]);
  }
  async move(
    source: string,
    destination: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
  ): Promise<void> {
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    this.calls.push(["move", source, destination, precondition]);
    if (this.moveError) throw this.moveError;
  }
  async delete(path: string): Promise<void> {
    this.calls.push(["delete", path]);
    if (this.deleteError) throw this.deleteError;
  }
}

const repositoryWith = (client: FakeClient, operationIds = ["op-1", "op-2"]) =>
  new WebDavResumeRepository(client, {
    deviceId: "device-1",
    createOperationId: () => operationIds.shift() ?? "fallback-op",
  });

const validResumeText = JSON.stringify({
  ...structuredClone(initialResumeState),
  id: "resume-id",
  title: "Resume",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  templateId: null,
});

test("ensureLayout creates root, objects, resumes, and trash collections in order", async () => {
  const client = new FakeClient();

  await repositoryWith(client).ensureLayout();

  assert.deepEqual(client.calls, [
    ["ensureDirectory", "/magic-resume/"],
    ["ensureDirectory", "/magic-resume/objects/"],
    ["ensureDirectory", "/magic-resume/resumes/"],
    ["ensureDirectory", "/magic-resume/trash/"],
  ]);
});

test("readManifest and readResume preserve path, text, and ETag metadata", async () => {
  const client = new FakeClient();
  client.files.set("/magic-resume/manifest.json", { text: "manifest", etag: '"m1"' });
  client.files.set("/magic-resume/resumes/CV.json", { text: "resume", etag: '"r1"' });
  const repository = repositoryWith(client);

  assert.deepEqual(await repository.readManifest(), {
    path: "manifest.json",
    text: "manifest",
    etag: '"m1"',
  });
  assert.deepEqual(await repository.readResume("resumes/CV.json"), {
    path: "resumes/CV.json",
    text: "resume",
    etag: '"r1"',
  });
});

test("writeResumeAtomic PUTs unique temporary siblings before conditional MOVEs and cleans them", async () => {
  const client = new FakeClient();
  const repository = repositoryWith(client);

  await repository.writeResumeAtomic("resumes/CV.json", validResumeText, null);
  await repository.writeResumeAtomic("resumes/CV.json", validResumeText, '"r1"');

  assert.deepEqual(client.calls, [
    ["putText", "/magic-resume/resumes/CV.json.tmp-device-1-op-1", validResumeText, { kind: "missing" }],
    ["move", "/magic-resume/resumes/CV.json.tmp-device-1-op-1", "/magic-resume/resumes/CV.json", { kind: "missing" }],
    ["delete", "/magic-resume/resumes/CV.json.tmp-device-1-op-1"],
    ["putText", "/magic-resume/resumes/CV.json.tmp-device-1-op-2", validResumeText, { kind: "missing" }],
    ["move", "/magic-resume/resumes/CV.json.tmp-device-1-op-2", "/magic-resume/resumes/CV.json", { kind: "match", etag: '"r1"' }],
    ["delete", "/magic-resume/resumes/CV.json.tmp-device-1-op-2"],
  ]);
});

test("writeResumeAtomic rejects envelopes and malformed JSON before any PUT", async () => {
  const client = new FakeClient();
  const repository = repositoryWith(client);
  const envelope = JSON.stringify({ schemaVersion: 2, data: JSON.parse(validResumeText) });

  await assert.rejects(
    repository.writeResumeAtomic("resumes/CV.json", envelope, null),
    /SNAPSHOT_RESUME/,
  );
  await assert.rejects(
    repository.writeResumeAtomic("trash/CV.json", "{broken", null),
    SyntaxError,
  );

  assert.deepEqual(client.calls, []);
});

test("a failed atomic MOVE cleans up without hiding the primary safe error", async () => {
  const client = new FakeClient();
  const primary = new WebDavError("REMOTE_CAS_MISMATCH", 412);
  client.moveError = primary;
  client.deleteError = new Error("private cleanup failure");

  await assert.rejects(
    repositoryWith(client).writeResumeAtomic("resumes/CV.json", validResumeText, '"old"'),
    (error: unknown) => error === primary,
  );
  assert.deepEqual(client.calls.map((call) => call[0]), ["putText", "move", "delete"]);
});

test("publishManifest uses create-only and matching ETag CAS without weakening it", async () => {
  const client = new FakeClient();
  const repository = repositoryWith(client);

  await repository.publishManifest("new", null);
  await repository.publishManifest("replacement", '"m1"');

  assert.deepEqual(client.calls.filter((call) => call[0] === "move"), [
    ["move", "/magic-resume/manifest.json.tmp-device-1-op-1", "/magic-resume/manifest.json", { kind: "missing" }],
    ["move", "/magic-resume/manifest.json.tmp-device-1-op-2", "/magic-resume/manifest.json", { kind: "match", etag: '"m1"' }],
  ]);
});

test("moveResumeAtomic applies CAS to validated resume and trash paths", async () => {
  const client = new FakeClient();

  await repositoryWith(client).moveResumeAtomic(
    "resumes/CV.json",
    "trash/CV.json",
    '"r1"',
  );

  assert.deepEqual(client.calls, [[
    "move",
    "/magic-resume/resumes/CV.json",
    "/magic-resume/trash/CV.json",
    { kind: "match", etag: '"r1"' },
  ]]);
});

test("listResumeCandidates includes only ordinary JSON files directly under resumes", async () => {
  const client = new FakeClient();
  client.listing = [
    { path: "CV one.json", etag: '"1"' },
    { path: "notes.txt", etag: '"2"' },
    { path: "CV.json.tmp-device-op", etag: '"3"' },
    { path: "trash/deleted.json", etag: '"4"' },
    { path: "nested/CV.json", etag: '"5"' },
    { path: "另一份.json", etag: null },
  ];

  assert.deepEqual(await repositoryWith(client).listResumeCandidates(), [
    { path: "resumes/CV one.json", etag: '"1"' },
    { path: "resumes/另一份.json", etag: null },
  ]);
  assert.deepEqual(client.calls, [["listCollection", "/magic-resume/resumes/"]]);
});

test("repository rejects unnormalized paths before making WebDAV calls", async () => {
  const client = new FakeClient();
  const repository = repositoryWith(client);

  await assert.rejects(repository.readResume("../secret.json"), WebDavError);
  await assert.rejects(repository.writeResumeAtomic("resumes/../secret.json", "{}"), WebDavError);
  await assert.rejects(repository.moveResumeAtomic("resumes/CV.json", "/outside.json", null), WebDavError);
  assert.deepEqual(client.calls, []);
});

test("managed immutable object paths accept full IDs and hashes while rejecting malformed nesting", async () => {
  const client = new FakeClient();
  const repository = repositoryWith(client);
  const hash = "a".repeat(64);
  const objectPath = `objects/resume-id/${hash}.json`;

  await repository.writeResumeAtomic(objectPath, validResumeText, null);

  assert.equal(client.calls.some((call) => call[0] === "move" && call[2] === `/magic-resume/${objectPath}`), true);
  for (const invalid of [
    `objects/resume-id/${"b".repeat(63)}.json`,
    `objects/resume-id/nested/${hash}.json`,
    `objects/../resume-id/${hash}.json`,
  ]) {
    await assert.rejects(repository.writeResumeAtomic(invalid, validResumeText, null), WebDavError);
  }
});
