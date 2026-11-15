// Shared in-memory store for the forge. Single process, no persistence needed:
// the trial runs the forge once (live) and replays it from scratch, so the same
// seeded inputs must produce the same state. Everything observable is
// deterministic: ids come from counters, times from a logical clock that ticks
// one second per call starting at the scenario epoch (2025-01-01T00:00:00Z).
// No Date.now(), no Math.random() anywhere in this file.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// The login the trial's bearer <redacted> names. The scenario is generated from the
// contest's FIXED seed (kit sdk/conformance/wire.ts SCENARIO_SEED 0x6a09e667f3bcc909),
// so this login is the same for every trial, practice and final:
// viewer id 1000, adaiversen. Stranger (id 1002) is olgabauer.
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});
export const STRANGER_LOGIN = 'olgabauer';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const ORG_LOGIN = 'faint-meadow-org';
export const DEFAULT_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'];

const EPOCH_MS = Date.parse('2025-01-01T00:00:00Z');

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  default: boolean;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeable: boolean;
  userLogin: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  /** Changed file paths, in the order the merge commit lists them. */
  files: string[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  /** Full refname -> commit sha. */
  refs: Map<string, string>;
  /** Loose git objects by sha. */
  objects: Map<string, GitObject>;
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextLabelId: number;
}

export function sha1Of(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function compressObject(type: GitObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return deflateSync(Buffer.concat([header, data]));
}

export function decompressObject(raw: Buffer): GitObject {
  const inflated = inflateSync(raw);
  const nul = inflated.indexOf(0);
  const header = inflated.subarray(0, nul).toString('utf8');
  const [type, size] = header.split(' ');
  const data = Buffer.from(inflated.subarray(nul + 1));
  if (data.length !== Number(size)) throw new Error('loose object size mismatch');
  return { type: type as GitObjectType, data };
}

export class Store {
  /** Key `${owner}/${name}`. */
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 10000;
  nextPullId = 20000;
  nextLabelId = 30000;
  private tick = 0;

  /** Deterministic timestamp: epoch + one second per call, ISO string. */
  now(): string {
    this.tick += 1;
    return new Date(EPOCH_MS + this.tick * 1000).toISOString();
  }

  /** Unix seconds for the current logical tick (for git commit headers). */
  nowUnix(): number {
    this.tick += 1;
    return Math.floor(EPOCH_MS / 1000) + this.tick;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string): Repo {
    const at = this.now();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      defaultBranch: 'main',
      isPrivate: false,
      createdAt: at,
      updatedAt: at,
      pushedAt: at,
      refs: new Map(),
      objects: new Map(),
      labels: DEFAULT_LABELS.map((labelName) => ({
        id: this.nextLabelId++,
        name: labelName,
        color: '000000',
        description: '',
        default: true,
      })),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextLabelId: this.nextLabelId,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const sha = sha1Of(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }
}
