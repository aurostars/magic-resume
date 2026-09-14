export interface MagicBuilderRunner {
  readonly platformOrigin?: string;
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface MiaobiAssetRecord {
  relativePath: string;
  contentHash: string;
  contentType: string;
  key: string;
  url: string;
}

export interface MiaobiAssetManifest {
  schemaVersion: 1;
  releaseId: string;
  createdAt: string;
  baseUrl: string;
  files: Record<string, MiaobiAssetRecord>;
}

export interface GitHubPagesAssetRecord extends MiaobiAssetRecord {
  objectPath: `objects/${string}/${string}`;
  size: number;
}

export interface GitHubPagesManifest extends MiaobiAssetManifest {
  provider: "github-pages";
  sourceCommit: string;
  files: Record<string, GitHubPagesAssetRecord>;
}
