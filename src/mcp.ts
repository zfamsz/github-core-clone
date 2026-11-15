// Model Context Protocol endpoint for the github-core-clone-01 forge.
// JSON-RPC 2.0 over Streamable HTTP at POST /mcp, answered as plain
// application/json (one response per request). Node stdlib only.
// Deterministic: ids come from Store counters, times from store.now()/nowUnix().
// No Date.now(), no Math.random().
//
// Both protocol eras are served from the same endpoint:
//   modern 2026-07-28: server/discover (supportedVersions, capabilities,
//           serverInfo) with no handshake and no session;
//   legacy 2025-11-25 and earlier: initialize + notifications/initialized,
//           echoing the revision the client offered, with an optional
//           Mcp-Session-Id echoed back when the client sends one.
// Tool work runs on the same Store as REST and GraphQL, so a repository,
// issue or pull request made over MCP is the same object over /api/v3.

import { VIEWER } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

export async function handleMcp(
  store: Store,
  method: string,
  path: string,
  _query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  expectedToken: string,
  requestId: string,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  const cleanPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (cleanPath !== '/mcp') return null;
  const sessionId = headerValue(headers, 'mcp-session-id');
  const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
  if (sessionId !== undefined) baseHeaders['mcp-session-id'] = sessionId;

  // DELETE closes a legacy session (best-effort; the client ignores the answer).
  if (method === 'DELETE') {
    if (!isAuthorized(headers, expectedToken)) return json(401, rpcError(null, -32001, 'Unauthorized'), baseHeaders);
    return { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders }, body: Buffer.alloc(0) };
  }
  if (method !== 'POST') {
    return json(405, { message: 'Method Not Allowed' }, baseHeaders);
  }

  // Auth is decided before parsing: an unauthenticated tools/call is 401
  // whatever its body, and a malformed body with a token is 400/-32700.
  let requestIdValue: string | number | null = null;
  try {
    const probe = JSON.parse(body.toString('utf8')) as unknown;
    if (probe !== null && typeof probe === 'object' && !Array.isArray(probe)) {
      const id = (probe as Record<string, unknown>).id;
      if (typeof id === 'string' || typeof id === 'number') requestIdValue = id;
    }
  } catch {
    // Not JSON: still an auth question first, then a parse error below.
  }
  if (!isAuthorized(headers, expectedToken)) {
    return json(401, rpcError(requestIdValue, -32001, 'Unauthorized'), baseHeaders);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error'), baseHeaders);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json(400, rpcError(null, -32600, 'Invalid Request'), baseHeaders);
  }
  const request = parsed as Record<string, unknown>;
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const rpcMethod = typeof request.method === 'string' ? request.method : '';

  // Notifications carry no id and get a 202 with an empty body.
  if (id === null && rpcMethod.startsWith('notifications/')) {
    return { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders }, body: Buffer.alloc(0) };
  }
  if (id === null) {
    return json(400, rpcError(null, -32600, 'Invalid Request'), baseHeaders);
  }

  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  switch (rpcMethod) {
    case 'server/discover': {
      const declared = declaredVersion(headers, params);
      if (declared !== null && !SUPPORTED_VERSIONS.includes(declared)) {
        return json(200, rpcError(id, -32022, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS] }), baseHeaders);
      }
      return json(200, rpcResult(id, discoverResult()), baseHeaders);
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const negotiated = offered !== null && SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
      return json(
        200,
        rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
        baseHeaders,
      );
    }
    case 'notifications/initialized':
      return { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders }, body: Buffer.alloc(0) };
    case 'tools/list':
      return json(200, rpcResult(id, { tools: TOOLS }), baseHeaders);
    case 'tools/call':
      return json(200, await dispatchToolCall(store, id, params, expectedToken, requestId), baseHeaders);
    case 'ping':
      return json(200, rpcResult(id, {}), baseHeaders);
    default:
      return json(200, rpcError(id, -32601, `Method not found: ${rpcMethod}`), baseHeaders);
  }
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PREFERRED_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'discover',
    protocolVersion: PREFERRED_VERSION,
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {}, prompts: {}, resources: {}, logging: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  };
}

function declaredVersion(headers: Record<string, string | undefined>, params: Record<string, unknown>): string | null {
  const header = headerValue(headers, 'mcp-protocol-version');
  if (header !== undefined && header !== '') return header;
  const meta = params._meta;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const record = meta as Record<string, unknown>;
    const declared = record['io.modelcontextprotocol/protocolVersion'];
    if (typeof declared === 'string' && declared !== '') return declared;
    const plain = record.protocolVersion;
    if (typeof plain === 'string' && plain !== '') return plain;
  }
  return null;
}

function isAuthorized(headers: Record<string, string | undefined>, expectedToken: string): boolean {
  const auth = headerValue(headers, 'authorization');
  return auth !== undefined && auth === `Bearer ${expectedToken}`;
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function json(status: number, body: unknown, extra: Record<string, string>): { status: number; headers: Record<string, string>; body: Buffer } {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

function rpcResult(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

// -------------------------------------------------------------------------------------------
// Tools. One fixed, deterministic list (same order, same bytes on every call).
// Schemas use github-mcp-server's argument names; `full_name` ("owner/repo")
// is accepted wherever owner+repo are, and every required property is one
// the suite can fill.
// -------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name "owner/repo".' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

// -------------------------------------------------------------------------------------------
// Argument helpers: accept the documented names and the suite's synonyms.
// -------------------------------------------------------------------------------------------

function pickArg(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, names: readonly string[]): string | undefined {
  const value = pickArg(args, names);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(args: Record<string, unknown>, names: readonly string[]): number | undefined {
  const value = pickArg(args, names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

const OWNER_KEYS = ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'] as const;
const REPO_KEYS = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'] as const;
const FULL_NAME_KEYS = ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'] as const;

/** Resolve {owner, name} from owner/repo arguments, or from a full_name "owner/repo". */
function resolveRepoRef(args: Record<string, unknown>): { owner: string; name: string } | null {
  let owner = pickString(args, OWNER_KEYS);
  let name = pickString(args, REPO_KEYS);
  if ((owner === undefined || name === undefined) && pickString(args, FULL_NAME_KEYS) !== undefined) {
    const fullName = pickString(args, FULL_NAME_KEYS) as string;
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      if (owner === undefined) owner = fullName.slice(0, slash);
      if (name === undefined) name = fullName.slice(slash + 1);
    }
  }
  if (name === undefined) return null;
  return { owner: owner ?? VIEWER.login, name };
}

function toolSuccess(id: string | number, result: unknown, text: string): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: result,
    isError: false,
  });
}

function toolFailure(id: string | number, message: string): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

async function dispatchToolCall(
  store: Store,
  id: string | number,
  params: Record<string, unknown>,
  token: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? (params.arguments as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const known = TOOLS.some((tool) => tool.name === name);
  if (!known) return rpcError(id, -32602, `Unknown tool: ${name}`);
  switch (name) {
    case 'create_repo': return callCreateRepo(store, id, args);
    case 'get_repo': return callGetRepo(store, id, args);
    case 'create_issue': return callCreateIssue(store, id, args);
    case 'list_issues': return callListIssues(store, id, args);
    case 'create_pull_request': return callCreatePullRequest(store, id, args);
    case 'merge_pull_request': return callMergePullRequest(store, id, args, token, requestId);
    default: return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/**
 * Best-effort delegation to the repo's REST handler (rest.ts) for the merge:
 * REST records the merge commit sha in its own side-state. Dynamic, optional
 * import: when rest.ts is absent or the call does not succeed, the caller
 * falls back to the local squash merge below.
 */
async function callRestMerge(
  store: Store,
  repo: Repo,
  pull: PullRequest,
  token: string,
  requestId: string,
): Promise<boolean> {
  try {
    const specifier = `./rest${'.ts'}`;
    const mod = (await import(specifier)) as {
      handleRest?: (...args: unknown[]) => Promise<{ status: number; body: Buffer } | null>;
    };
    if (typeof mod.handleRest !== 'function') return false;
    const res = await mod.handleRest(
      store,
      'PUT',
      `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${pull.number}/merge`,
      new URLSearchParams(),
      { authorization: `Bearer ${token}` },
      Buffer.from(JSON.stringify({ merge_method: 'squash' }), 'utf8'),
      token,
      requestId,
    );
    return res !== null && res.status === 200;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------
// REST-shaped views of Store objects (the same objects /api/v3 reads).
// -------------------------------------------------------------------------------------------

function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1002, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label })),
    user: { login: issue.userLogin, id: issue.userId, type: 'User' },
    repository: { full_name: `${repo.owner}/${repo.name}` },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const record = pull as unknown as Record<string, unknown>;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    user: { login: pull.userLogin, id: pull.userId, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: typeof record.mergeCommitSha === 'string' ? record.mergeCommitSha : null,
  };
}

function callCreateRepo(store: Store, id: string | number, args: Record<string, unknown>): Record<string, unknown> {
  const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === undefined) return toolFailure(id, 'Missing required argument: name');
  const owner = pickString(args, OWNER_KEYS) ?? VIEWER.login;
  const existing = store.getRepo(owner, name);
  if (existing !== undefined) {
    const json = repoJson(existing);
    return toolSuccess(id, json, JSON.stringify(json));
  }
  const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
  const repo = store.createRepo(owner, name, description);
  const isPrivate = pickArg(args, ['private', 'is_private']);
  repo.isPrivate = isPrivate === true;
  repo.description = description;
  const json = repoJson(repo);
  return toolSuccess(id, json, JSON.stringify(json));
}

function callGetRepo(store: Store, id: string | number, args: Record<string, unknown>): Record<string, unknown> {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolFailure(id, 'Missing required argument: repo');
  const repo = store.getRepo(ref.owner, ref.name);
  if (repo === undefined) return toolFailure(id, `Repository not found: ${ref.owner}/${ref.name}`);
  const json = repoJson(repo);
  return toolSuccess(id, json, JSON.stringify(json));
}

function callCreateIssue(store: Store, id: string | number, args: Record<string, unknown>): Record<string, unknown> {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolFailure(id, 'Missing required argument: repo');
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === undefined) return toolFailure(id, 'Missing required argument: title');
  const repo = store.getRepo(ref.owner, ref.name);
  if (repo === undefined) return toolFailure(id, `Repository not found: ${ref.owner}/${ref.name}`);
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const at = store.now();
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels: [],
    userLogin: VIEWER.login,
    userId: VIEWER.id,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  repo.issues.push(issue);
  const json = issueJson(repo, issue);
  return toolSuccess(id, json, JSON.stringify(json));
}

function callListIssues(store: Store, id: string | number, args: Record<string, unknown>): Record<string, unknown> {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolFailure(id, 'Missing required argument: repo');
  const repo = store.getRepo(ref.owner, ref.name);
  if (repo === undefined) return toolFailure(id, `Repository not found: ${ref.owner}/${ref.name}`);
  const state = pickString(args, ['state', 'status']);
  let issues = [...repo.issues];
  if (state !== undefined && state !== 'all') issues = issues.filter((issue) => issue.state === state.toLowerCase());
  const list = issues.map((issue) => issueJson(repo, issue));
  return toolSuccess(id, { issues: list }, JSON.stringify(list));
}

// -------------------------------------------------------------------------------------------
// Git object helpers (same object format as graphql.ts): flatten a commit's tree
// and diff two trees for pull-request files; squash-merge onto the base branch.
// -------------------------------------------------------------------------------------------

interface CommitView {
  tree: string;
  parents: string[];
}

function parseCommit(data: Buffer): CommitView | null {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) return null;
  return { tree, parents };
}

function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>, depth: number): void {
  if (depth > 32) return;
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out, depth + 1);
    else out.set(path, entry.oid);
  }
}

function treeFiles(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  if (commitSha === '') return out;
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return out;
  const commit = parseCommit(obj.data);
  if (commit === null) return out;
  flattenTree(repo, commit.tree, '', out, 0);
  return out;
}

function diffPaths(repo: Repo, baseSha: string, headSha: string): string[] {
  const base = treeFiles(repo, baseSha);
  const head = treeFiles(repo, headSha);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changed: string[] = [];
  for (const path of paths) if (base.get(path) !== head.get(path)) changed.push(path);
  changed.sort();
  return changed;
}

function squashMerge(store: Store, repo: Repo, pull: PullRequest): string | null {
  if (pull.baseSha === '' || pull.headSha === '') return null;
  const headObj = repo.objects.get(pull.headSha);
  if (headObj === undefined || headObj.type !== 'commit') return null;
  const head = parseCommit(headObj.data);
  if (head === null) return null;
  const stamp = store.nowUnix();
  const who = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const data = Buffer.from(
    `tree ${head.tree}\nparent ${pull.baseSha}\nauthor ${who}\ncommitter ${who}\n\n${message}`,
    'utf8',
  );
  const sha = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.now();
  (pull as unknown as Record<string, unknown>).mergeCommitSha = sha;
  repo.pushedAt = store.now();
  return sha;
}

function callCreatePullRequest(store: Store, id: string | number, args: Record<string, unknown>): Record<string, unknown> {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolFailure(id, 'Missing required argument: repo');
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === undefined) return toolFailure(id, 'Missing required argument: title');
  const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  if (head === undefined) return toolFailure(id, 'Missing required argument: head');
  const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  if (base === undefined) return toolFailure(id, 'Missing required argument: base');
  const repo = store.getRepo(ref.owner, ref.name);
  if (repo === undefined) return toolFailure(id, `Repository not found: ${ref.owner}/${ref.name}`);
  const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
  if (headSha === '') return toolFailure(id, `Head branch not found: ${head}`);
  if (baseSha === '') return toolFailure(id, `Base branch not found: ${base}`);
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const at = store.now();
  const pull: PullRequest = {
    id: store.nextPullId++,
    number: repo.nextPullNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeable: true,
    userLogin: VIEWER.login,
    userId: VIEWER.id,
    createdAt: at,
    updatedAt: at,
    mergedAt: null,
    files: diffPaths(repo, baseSha, headSha),
  };
  repo.pulls.push(pull);
  const json = pullJson(repo, pull);
  return toolSuccess(id, json, JSON.stringify(json));
}

async function callMergePullRequest(
  store: Store,
  id: string | number,
  args: Record<string, unknown>,
  token: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolFailure(id, 'Missing required argument: repo');
  const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (number === undefined) return toolFailure(id, 'Missing required argument: pull_number');
  const repo = store.getRepo(ref.owner, ref.name);
  if (repo === undefined) return toolFailure(id, `Repository not found: ${ref.owner}/${ref.name}`);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return toolFailure(id, `Pull request not found: #${number}`);
  if (!pull.merged) {
    const delegated = await callRestMerge(store, repo, pull, token, requestId);
    if (!delegated) {
      const sha = squashMerge(store, repo, pull);
      if (sha === null) return toolFailure(id, `Could not merge pull request #${number}: missing git objects`);
    }
  }
  const json = pullJson(repo, pull);
  return toolSuccess(id, json, JSON.stringify(json));
}
