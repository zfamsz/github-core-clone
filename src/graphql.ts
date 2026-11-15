// Minimal GraphQL v4 executor for the github-core-clone-01 conformance suite.
// Node stdlib only. Deterministic: ids come from Store counters, times from
// store.now()/nowUnix(). No Date.now(), no Math.random().
//
// Scope: exactly the documents the suite sends (gh / github-mcp-server shapes):
// viewer/repository/node/__type/__schema reads, issue & pull-request reads,
// createIssue/closeIssue/createPullRequest/mergePullRequest/addComment, cursor
// pagination on issues, and JSON-array operation batching. Unknown fields are
// reported as GraphQL errors with HTTP 200; an unknown repository is
// data.repository = null with no errors.

import { VIEWER } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

export async function handleGraphQL(
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
  if (cleanPath !== '/api/graphql') return null;
  const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
  if (!isAuthorized(headers, expectedToken)) {
    return json(401, { message: 'Unauthorized' }, baseHeaders);
  }
  if (method !== 'POST') {
    return json(405, { message: 'Method Not Allowed' }, baseHeaders);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return json(400, { errors: [{ message: 'Request body is not valid JSON' }] }, baseHeaders);
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) results.push(await executeOperation(store, entry, expectedToken, requestId));
    return json(200, results, baseHeaders);
  }
  return json(200, await executeOperation(store, parsed, expectedToken, requestId), baseHeaders);
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

// -------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque base64 of "Kind:<numeric id>", stable across reads.
// -------------------------------------------------------------------------------------------

function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(value: string): { kind: string; id: number } | null {
  try {
    const raw = Buffer.from(value, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(raw);
    if (match === null) return null;
    return { kind: match[1] as string, id: Number(match[2]) };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: number): { repo: Repo; pull: PullRequest } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls) if (pull.id === id) return { repo, pull };
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Git object helpers: flatten a commit's tree and diff two trees, so pull-request
// files can be read from the Store's git objects (same object format as the
// suite's git-client: "mode name\0<20-byte sha>" tree entries, "tree <sha>"
// commit headers).
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

/** Paths whose blob differs between base and head (added, removed or changed), sorted. */
function diffPaths(repo: Repo, baseSha: string, headSha: string): string[] {
  const base = treeFiles(repo, baseSha);
  const head = treeFiles(repo, headSha);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changed: string[] = [];
  for (const path of paths) if (base.get(path) !== head.get(path)) changed.push(path);
  changed.sort();
  return changed;
}

function isAncestor(repo: Repo, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === '' || descendantSha === '') return false;
  if (ancestorSha === descendantSha) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendantSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestorSha) return true;
      queue.push(parent);
    }
    if (seen.size > 10000) return false;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is
 * the head tree, parented on the base tip, then the base ref moves to it.
 * Returns the merge commit sha, or null when the git objects are missing.
 */
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

function mergeableState(repo: Repo, pull: PullRequest): string {
  if (pull.headSha === pull.baseSha) return 'MERGEABLE';
  return isAncestor(repo, pull.baseSha, pull.headSha) ? 'MERGEABLE' : 'UNKNOWN';
}

// -------------------------------------------------------------------------------------------
// Tokenizer + parser for the subset of GraphQL the suite sends.
// -------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@=&|$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, unknown>;
  selections: Selection[] | null;
}
interface SpreadSelection {
  kind: 'spread';
  name: string;
}
interface InlineSelection {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}
type Selection = FieldSelection | SpreadSelection | InlineSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, unknown>;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
    return token.value;
  }
  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '{') {
      return { type, name: null, variableDefaults: {}, selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword === 'mutation') type = 'mutation';
    else if (keyword !== 'query') throw new Error(`Unsupported operation type ${JSON.stringify(keyword)}`);
    let name: string | null = null;
    const next = this.peek();
    if (next?.kind === 'name') name = this.next().value;
    const variableDefaults: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          variableDefaults[varName] = this.parseValue({});
        }
        if (this.peek() === undefined) throw new Error('Unexpected end of variable definitions');
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { type, name, variableDefaults, selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.peek() === undefined) throw new Error('Unexpected end of selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let alias = nameOrAlias;
    let name = nameOrAlias;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      if (this.peek() === undefined) throw new Error('Unexpected end of arguments');
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(args);
    }
    this.expectPunct(')');
    return args;
  }

  /** Values still hold {$var: name} placeholders; they are resolved after parsing. */
  private parseValue(_args: Record<string, unknown>): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { $var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        if (this.peek() === undefined) throw new Error('Unexpected end of list value');
        list.push(this.parseValue(_args));
      }
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        if (this.peek() === undefined) throw new Error('Unexpected end of object value');
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue(_args);
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum literal: its name as a string
    }
    throw new Error(`Unexpected token ${JSON.stringify(token.value)} in GraphQL value`);
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('$var' in record && typeof record.$var === 'string' && Object.keys(record).length === 1) {
      return variables[record.$var] ?? null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVariables(entry, variables);
    return out;
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// Schema surface (for __type/__schema and for unknown-field validation).
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body'],
  User: ['id', 'login', 'name'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
};

const TYPE_ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeKind(name: string): string {
  if (name in TYPE_ENUMS) return 'ENUM';
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') return 'SCALAR';
  return 'OBJECT';
}

function typeInfo(name: string): { fields: readonly string[]; enums: readonly string[] } | null {
  if (name in TYPE_FIELDS) return { fields: TYPE_FIELDS[name] as readonly string[], enums: [] };
  if (name in TYPE_ENUMS) return { fields: [], enums: TYPE_ENUMS[name] as readonly string[] };
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') return { fields: [], enums: [] };
  return null;
}

// -------------------------------------------------------------------------------------------
// Execution. Values are "wrappers": plain records carrying __type plus the entity.
// -------------------------------------------------------------------------------------------

type Wrapper = Record<string, unknown> & { __type: string };

interface ExecContext {
  store: Store;
  errors: { message: string }[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
  token: string;
  requestId: string;
}

/**
 * Best-effort delegation to the repo's REST handler (rest.ts) for the two
 * mutations whose REST view keeps private side-state the Store does not
 * carry: issue comments (REST keeps them in its own per-repo map) and the
 * merge commit sha (REST keeps it in its own map). The import is dynamic
 * and optional: when rest.ts is absent or the call does not succeed, the
 * caller falls back to the local Store implementation below, so this module
 * still works standalone.
 */
async function callRest(
  ctx: ExecContext,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown } | null> {
  try {
    const specifier = `./rest${'.ts'}`;
    const mod = (await import(specifier)) as {
      handleRest?: (...args: unknown[]) => Promise<{ status: number; body: Buffer } | null>;
    };
    if (typeof mod.handleRest !== 'function') return null;
    const res = await mod.handleRest(
      ctx.store,
      method,
      path,
      new URLSearchParams(),
      { authorization: `Bearer ${ctx.token}` },
      Buffer.from(JSON.stringify(body), 'utf8'),
      ctx.token,
      ctx.requestId,
    );
    if (res === null || typeof res.status !== 'number') return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(res.body.toString('utf8')) as unknown;
    } catch {
      return null;
    }
    return { status: res.status, json: parsed };
  } catch {
    return null;
  }
}

async function executeOperation(store: Store, entry: unknown, token: string, requestId: string): Promise<Record<string, unknown>> {
  const ctx: ExecContext = { store, errors: [], fragments: new Map(), token, requestId };
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Request body must be a GraphQL operation object' }] };
  }
  const record = entry as Record<string, unknown>;
  const queryText = record.query;
  if (typeof queryText !== 'string' || queryText.trim() === '') {
    return { data: null, errors: [{ message: 'Request body has no query string' }] };
  }
  const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
    ? (record.variables as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(tokenize(queryText)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Could not parse the GraphQL document' }] };
  }
  ctx.fragments = document.fragments;
  let operation: Operation | undefined;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  if (operationName !== null) operation = document.operations.find((op) => op.name === operationName);
  else operation = document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation ${JSON.stringify(operationName)}` }] };
  }
  const mergedVariables: Record<string, unknown> = { ...operation.variableDefaults, ...variables };
  const root: Wrapper = operation.type === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const resolvedSelections = resolveSelectionArgs(operation.selections, mergedVariables);
  const data = await executeSelections(ctx, root, resolvedSelections);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function resolveSelectionArgs(selections: Selection[], variables: Record<string, unknown>): Selection[] {
  return selections.map((selection) => {
    if (selection.kind === 'field') {
      return {
        ...selection,
        args: resolveVariables(selection.args, variables) as Record<string, unknown>,
        selections: selection.selections === null ? null : resolveSelectionArgs(selection.selections, variables),
      };
    }
    if (selection.kind === 'inline') return { ...selection, selections: resolveSelectionArgs(selection.selections, variables) };
    return selection;
  });
}

function isWrapper(value: unknown): value is Wrapper {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).__type === 'string';
}

async function executeSelections(ctx: ExecContext, parent: Wrapper, selections: Selection[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const value = await resolveField(ctx, parent, selection);
      out[selection.alias] = await projectValue(ctx, value, selection.selections);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__type) {
        Object.assign(out, await executeSelections(ctx, parent, selection.selections));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === parent.__type) {
        Object.assign(out, await executeSelections(ctx, parent, fragment.selections));
      }
    }
  }
  return out;
}

async function projectValue(ctx: ExecContext, value: unknown, selections: Selection[] | null): Promise<unknown> {
  if (selections === null || selections === undefined) return value;
  if (isWrapper(value)) return executeSelections(ctx, value, selections);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) out.push(isWrapper(entry) ? await executeSelections(ctx, entry, selections) : entry);
    return out;
  }
  return value;
}

function unknownField(ctx: ExecContext, parentType: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${parentType}".` });
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function userWrapper(login: string, id: number): Wrapper {
  return { __type: 'User', login, id };
}

function repoWrapper(repo: Repo): Wrapper {
  return { __type: 'Repository', repo };
}

function issueWrapper(repo: Repo, issue: Issue): Wrapper {
  return { __type: 'Issue', repo, issue };
}

function pullWrapper(repo: Repo, pull: PullRequest): Wrapper {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Wrapper {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asRecord(args.orderBy);
  const field = orderBy !== null ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy !== null ? String(orderBy.direction ?? 'ASC') : 'ASC';
  const dir = direction === 'DESC' ? -1 : 1;
  issues.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') cmp = commentCount(a) - commentCount(b);
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * dir;
  });
  const afterNumber = cursorNumber(args.after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = asNumber(args.first);
  const total = issues.length;
  const page = first !== null ? issues.slice(0, first) : issues;
  const hasNextPage = page.length < total;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
  const startCursor = page.length > 0 ? cursorFor((page[0] as Issue).number) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueWrapper(repo, issue)),
    pageInfo: { __type: 'PageInfo', hasNextPage, hasPreviousPage: afterNumber !== null, startCursor, endCursor },
    totalCount: total,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Wrapper {
  const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
  const first = asNumber(args.first);
  const page = first !== null ? pulls.slice(0, first) : pulls;
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullWrapper(repo, pull)),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: page.length < pulls.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor((page[0] as PullRequest).number) : null,
      endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as PullRequest).number) : null,
    },
    totalCount: pulls.length,
  };
}

function commentCount(issue: Issue): number {
  const comments = (issue as unknown as Record<string, unknown>).comments;
  return Array.isArray(comments) ? comments.length : 0;
}

function commentsOf(issue: Issue): Record<string, unknown>[] {
  const record = issue as unknown as Record<string, unknown>;
  if (!Array.isArray(record.comments)) record.comments = [];
  return record.comments as Record<string, unknown>[];
}

function typeWrapper(name: string): Wrapper | null {
  const info = typeInfo(name);
  if (info === null) return null;
  return { __type: '__Type', name, kind: typeKind(name), fieldNames: info.fields, enumNames: info.enums };
}

async function resolveField(ctx: ExecContext, parent: Wrapper, selection: FieldSelection): Promise<unknown> {
  const type = parent.__type;
  const field = selection.name;
  const args = selection.args;
  if (field === '__typename') return type;
  const known = TYPE_FIELDS[type];
  if (known !== undefined && !known.includes(field)) return unknownField(ctx, type, field);

  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userWrapper(VIEWER.login, VIEWER.id);
      if (field === 'repository') {
        const owner = asString(args.owner);
        const name = asString(args.name);
        if (owner === null || name === null) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? null : repoWrapper(repo);
      }
      if (field === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(ctx.store, decoded.id);
          return repo === undefined ? null : repoWrapper(repo);
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueById(ctx.store, decoded.id);
          return found === null ? null : issueWrapper(found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullById(ctx.store, decoded.id);
          return found === null ? null : pullWrapper(found.repo, found.pull);
        }
        return null;
      }
      if (field === '__type') {
        const name = asString(args.name);
        return name === null ? null : typeWrapper(name);
      }
      if (field === '__schema') return { __type: '__Schema' };
      return unknownField(ctx, type, field);
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, args);
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (field === 'id') return globalId('Repository', repo.id);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userWrapper(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 1002);
      if (field === 'defaultBranchRef') return { __type: 'Ref', name: repo.defaultBranch };
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const number = asNumber(args.number);
        if (number === null) return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueWrapper(repo, issue);
      }
      if (field === 'issues') return issueConnection(repo, args);
      if (field === 'pullRequest') {
        const number = asNumber(args.number);
        if (number === null) return null;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullWrapper(repo, pull);
      }
      if (field === 'pullRequests') return pullConnection(repo, args);
      return unknownField(ctx, type, field);
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      if (field === 'id') return globalId('Issue', issue.id);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issue.body;
      return unknownField(ctx, type, field);
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      if (field === 'id') return globalId('PullRequest', pull.id);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pull.merged;
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'mergeable') return mergeableState(repo, pull);
      if (field === 'body') return pull.body;
      if (field === 'files') {
        const first = asNumber(args.first);
        const paths = pull.files.length > 0 ? pull.files : diffPaths(repo, pull.baseSha, pull.headSha);
        const page = first !== null ? paths.slice(0, first) : paths;
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: page.map((path) => ({ __type: 'PullRequestChangedFile', path })),
          pageInfo: { __type: 'PageInfo', hasNextPage: page.length < paths.length, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: paths.length,
        };
      }
      return unknownField(ctx, type, field);
    }
    case 'User': {
      const login = parent.login as string;
      const id = parent.id as number;
      if (field === 'id') return globalId('User', id);
      if (field === 'login') return login;
      if (field === 'name') return login === VIEWER.login ? VIEWER.name : login;
      return unknownField(ctx, type, field);
    }
    case 'Ref': {
      if (field === 'name') return parent.name as string;
      return unknownField(ctx, type, field);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return parent.nodes as unknown[];
      if (field === 'pageInfo') return parent.pageInfo as Wrapper;
      if (field === 'totalCount') return parent.totalCount as number;
      return unknownField(ctx, type, field);
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return parent.path as string;
      return unknownField(ctx, type, field);
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return parent.hasNextPage as boolean;
      if (field === 'hasPreviousPage') return parent.hasPreviousPage as boolean;
      if (field === 'startCursor') return parent.startCursor as string | null;
      if (field === 'endCursor') return parent.endCursor as string | null;
      return unknownField(ctx, type, field);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return (parent.issue as Wrapper | null) ?? null;
      if (field === 'clientMutationId') return (parent.clientMutationId as string | null) ?? null;
      return unknownField(ctx, type, field);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return (parent.pullRequest as Wrapper | null) ?? null;
      if (field === 'clientMutationId') return (parent.clientMutationId as string | null) ?? null;
      return unknownField(ctx, type, field);
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return (parent.commentEdge as Wrapper | null) ?? null;
      if (field === 'clientMutationId') return (parent.clientMutationId as string | null) ?? null;
      return unknownField(ctx, type, field);
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return (parent.node as Wrapper | null) ?? null;
      if (field === 'cursor') return (parent.cursor as string | null) ?? null;
      return unknownField(ctx, type, field);
    }
    case 'IssueComment': {
      if (field === 'id') return parent.id as string;
      if (field === 'body') return parent.body as string;
      return unknownField(ctx, type, field);
    }
    case '__Type': {
      if (field === 'name') return parent.name as string;
      if (field === 'kind') return parent.kind as string;
      if (field === 'description') return null;
      if (field === 'fields') return (parent.fieldNames as readonly string[]).map((name) => ({ __type: '__Field', name }));
      if (field === 'enumValues') return (parent.enumNames as readonly string[]).map((name) => ({ __type: '__EnumValue', name }));
      return unknownField(ctx, type, field);
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return parent.name as string;
      if (field === 'description') return null;
      return unknownField(ctx, type, field);
    }
    case '__Schema': {
      if (field === 'description') return null;
      if (field === 'types') {
        return [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUMS), 'String', 'Int', 'Boolean', 'ID']
          .map((name) => typeWrapper(name))
          .filter((entry): entry is Wrapper => entry !== null);
      }
      if (field === 'queryType') return typeWrapper('Query');
      if (field === 'mutationType') return typeWrapper('Mutation');
      return unknownField(ctx, type, field);
    }
    default:
      return unknownField(ctx, type, field);
  }
}

async function resolveMutation(ctx: ExecContext, field: string, args: Record<string, unknown>): Promise<Wrapper | null> {
  const input = asRecord(args.input) ?? {};
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (field) {
    case 'createIssue': {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(ctx.store, decoded.id) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: `Repository not found: ${String(input.repositoryId ?? '')}` });
        return { __type: 'CreateIssuePayload', issue: null, clientMutationId };
      }
      const at = ctx.store.now();
      const issue: Issue = {
        id: ctx.store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        userId: VIEWER.id,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
      };
      repo.issues.push(issue);
      return { __type: 'CreateIssuePayload', issue: issueWrapper(repo, issue), clientMutationId };
    }
    case 'closeIssue': {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const found = decoded !== null && decoded.kind === 'Issue' ? findIssueById(ctx.store, decoded.id) : null;
      if (found === null) {
        ctx.errors.push({ message: `Issue not found: ${String(input.issueId ?? '')}` });
        return { __type: 'CloseIssuePayload', issue: null, clientMutationId };
      }
      const at = ctx.store.now();
      found.issue.state = 'closed';
      found.issue.closedAt = at;
      found.issue.updatedAt = at;
      return { __type: 'CloseIssuePayload', issue: issueWrapper(found.repo, found.issue), clientMutationId };
    }
    case 'createPullRequest': {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(ctx.store, decoded.id) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: `Repository not found: ${String(input.repositoryId ?? '')}` });
        return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId };
      }
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      if (headSha === '') {
        ctx.errors.push({ message: `Head branch not found: ${headRef}` });
        return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId };
      }
      if (baseSha === '') {
        ctx.errors.push({ message: `Base branch not found: ${baseRef}` });
        return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId };
      }
      const at = ctx.store.now();
      const pull: PullRequest = {
        id: ctx.store.nextPullId++,
        number: repo.nextPullNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        headRef,
        baseRef,
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
      return { __type: 'CreatePullRequestPayload', pullRequest: pullWrapper(repo, pull), clientMutationId };
    }
    case 'mergePullRequest': {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const found = decoded !== null && decoded.kind === 'PullRequest' ? findPullById(ctx.store, decoded.id) : null;
      if (found === null) {
        ctx.errors.push({ message: `Pull request not found: ${String(input.pullRequestId ?? '')}` });
        return { __type: 'MergePullRequestPayload', pullRequest: null, clientMutationId };
      }
      if (!found.pull.merged) {
        // Prefer the REST merge when it is available: it records the merge
        // commit sha in REST's own side-state. Fall back to the local squash.
        const delegated = await callRest(
          ctx,
          'PUT',
          `/api/v3/repos/${encodeURIComponent(found.repo.owner)}/${encodeURIComponent(found.repo.name)}/pulls/${found.pull.number}/merge`,
          { merge_method: 'squash' },
        );
        if (delegated === null || delegated.status !== 200) {
          const sha = squashMerge(ctx.store, found.repo, found.pull);
          if (sha === null) {
            ctx.errors.push({ message: `Could not merge pull request #${found.pull.number}: missing git objects` });
            return { __type: 'MergePullRequestPayload', pullRequest: pullWrapper(found.repo, found.pull), clientMutationId };
          }
        }
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullWrapper(found.repo, found.pull), clientMutationId };
    }
    case 'addComment': {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const body = typeof input.body === 'string' ? input.body : '';
      if (decoded !== null && decoded.kind === 'Issue') {
        const found = findIssueById(ctx.store, decoded.id);
        if (found === null) {
          ctx.errors.push({ message: `Issue not found: ${String(input.subjectId ?? '')}` });
          return { __type: 'AddCommentPayload', commentEdge: null, clientMutationId };
        }
        // Prefer the REST comment route when it is available: REST keeps
        // comments in its own per-repo map, which is what GET
        // /issues/{n}/comments reads. Fall back to storing the comment on
        // the Issue object itself.
        const delegated = await callRest(
          ctx,
          'POST',
          `/api/v3/repos/${encodeURIComponent(found.repo.owner)}/${encodeURIComponent(found.repo.name)}/issues/${found.issue.number}/comments`,
          { body },
        );
        const delegatedRecord = delegated !== null && delegated.status === 201 ? asRecord(delegated.json) : null;
        if (delegatedRecord !== null && typeof delegatedRecord.id === 'number' && typeof delegatedRecord.body === 'string') {
          const node: Wrapper = { __type: 'IssueComment', id: globalId('IssueComment', delegatedRecord.id), body: delegatedRecord.body };
          return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: null }, clientMutationId };
        }
        const at = ctx.store.now();
        const numericId = ctx.store.nextIssueId++;
        const comment: Record<string, unknown> = {
          id: numericId,
          node_id: globalId('IssueComment', numericId),
          body,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: at,
          updated_at: at,
        };
        commentsOf(found.issue).push(comment);
        const node: Wrapper = { __type: 'IssueComment', id: globalId('IssueComment', numericId), body };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: null }, clientMutationId };
      }
      if (decoded !== null && decoded.kind === 'PullRequest') {
        const found = findPullById(ctx.store, decoded.id);
        if (found === null) {
          ctx.errors.push({ message: `Pull request not found: ${String(input.subjectId ?? '')}` });
          return { __type: 'AddCommentPayload', commentEdge: null, clientMutationId };
        }
        const at = ctx.store.now();
        const numericId = ctx.store.nextIssueId++;
        const record = found.pull as unknown as Record<string, unknown>;
        if (!Array.isArray(record.comments)) record.comments = [];
        (record.comments as Record<string, unknown>[]).push({
          id: numericId,
          node_id: globalId('IssueComment', numericId),
          body,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: at,
          updated_at: at,
        });
        const node: Wrapper = { __type: 'IssueComment', id: globalId('IssueComment', numericId), body };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: null }, clientMutationId };
      }
      ctx.errors.push({ message: `Comment subject not found: ${String(input.subjectId ?? '')}` });
      return { __type: 'AddCommentPayload', commentEdge: null, clientMutationId };
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field}" on type "Mutation".` });
      return null;
  }
}
