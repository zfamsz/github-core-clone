// GitHub REST v3 surface for the forge: repos, contents, branches, commits,
// labels, issues (+ comments) and pull requests (+ files, squash merge).
// Node stdlib only. Deterministic: ids from Store counters, times from
// store.now()/store.nowUnix(). No Date.now(), no Math.random().

import { VIEWER } from './store.ts';
import type { Issue, Label, PullRequest, Repo, Store } from './store.ts';

export async function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  expectedToken: string,
  requestId: string,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  const cleanPath = path.split('?')[0] ?? '';
  if (cleanPath !== '/api/v3' && !cleanPath.startsWith('/api/v3/')) return null;
  const rest = cleanPath === '/api/v3' ? '' : cleanPath.slice('/api/v3/'.length);
  const segments = rest === '' ? [] : rest.split('/').map((s) => safeDecode(s));

  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'x-oauth-scopes': 'repo, read:org',
  };
  const json = (status: number, value: unknown, extra: Record<string, string> = {}) => ({
    status,
    headers: { ...baseHeaders, ...extra },
    body: Buffer.from(JSON.stringify(value)),
  });
  const empty = (status: number, extra: Record<string, string> = {}) => ({
    status,
    headers: { ...baseHeaders, ...extra },
    body: Buffer.alloc(0),
  });
  const err = (status: number, message: string) => json(status, { message });
  const notFound = (what = 'Not Found') => err(404, what);

  const origin = originOf(headers);
  const linkFor = (route: string, params: Record<string, string>, page: number, perPage: number, total: number): string | null => {
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (totalPages <= 1) return null;
    const urlFor = (p: number): string => {
      const q = new URLSearchParams({ ...params, page: String(p), per_page: String(perPage) });
      return `${origin}${route}?${q.toString()}`;
    };
    const parts: string[] = [];
    if (page < totalPages) {
      parts.push(`<${urlFor(page + 1)}>; rel="next"`);
      parts.push(`<${urlFor(totalPages)}>; rel="last"`);
    }
    if (page > 1) {
      parts.push(`<${urlFor(1)}>; rel="first"`);
      parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
    }
    return parts.join(', ');
  };
  // paginate + Link header; `route` is the path the Link URLs point at.
  const pageOf = <T>(items: T[], route: string, params: Record<string, string>): { items: T[]; link: string | null } => {
    const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const start = (page - 1) * perPage;
    return { items: items.slice(start, start + perPage), link: linkFor(route, params, page, perPage, items.length) };
  };
  const m = method.toUpperCase();
  const isRoot = segments.length === 0;
  const isMeta = segments.length === 1 && segments[0] === 'meta';

  // Public endpoints (no token required): the API root and /meta.
  if (m === 'GET' && isRoot) {
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    });
  }
  if (m === 'GET' && isMeta) {
    return json(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      api: ['2022-11-28'],
      hooks: [],
      git: [],
      github_enterprise_importer: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
  }

  // Auth: every other /api/v3 route needs the bearer token.
  const auth = headerValue(headers, 'authorization');
  const token = auth !== undefined && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : auth !== undefined && /^token\s+/i.test(auth) ? auth.replace(/^token\s+/i, '') : undefined;
  if (token === undefined || token !== expectedToken) {
    return err(401, 'Requires authentication');
  }

  // Malformed JSON body -> 400 (only when a body was actually sent).
  let parsed: unknown = {};
  if (body.length > 0 && (m === 'POST' || m === 'PATCH' || m === 'PUT' || m === 'DELETE')) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return err(400, 'Problems parsing JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) parsed = {};
  }
  const input = parsed as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

  // ---- /user ----
  if (segments.length === 1 && segments[0] === 'user') {
    if (m !== 'GET') return notFound();
    return json(200, userJson());
  }

  // ---- /user/repos ----
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (m === 'GET') {
      const repos = store.listReposFor(VIEWER.login);
      const params: Record<string, string> = {};
      const perPage = query.get('per_page');
      if (perPage !== null) params.per_page = perPage;
      const { items, link } = pageOf(repos.map(repoJson), '/api/v3/user/repos', params);
      return json(200, items, link !== null ? { link } : {});
    }
    if (m === 'POST') {
      const name = str(input.name);
      if (name === undefined || name === '') return err(422, 'name is required');
      if (store.getRepo(VIEWER.login, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER.login, name, str(input.description) ?? '');
      repo.isPrivate = bool(input.private) ?? false;
      const db = str(input.default_branch);
      if (db !== undefined && db !== '') repo.defaultBranch = db;
      return json(201, repoJson(repo));
    }
    return notFound();
  }

  // ---- /repos/{owner}/{repo}... ----
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] ?? '';
    const repoName = segments[2] ?? '';
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (m === 'GET') {
        if (repo === undefined) return notFound('Not Found');
        return json(200, repoJson(repo));
      }
      if (m === 'PATCH') {
        if (repo === undefined) return notFound('Not Found');
        const d = str(input.description);
        if (d !== undefined) repo.description = d;
        const p = bool(input.private);
        if (p !== undefined) repo.isPrivate = p;
        const db = str(input.default_branch);
        if (db !== undefined && db !== '') repo.defaultBranch = db;
        repo.updatedAt = store.now();
        return json(200, repoJson(repo));
      }
      if (m === 'DELETE') {
        if (repo === undefined) return notFound('Not Found');
        store.deleteRepo(owner, repoName);
        commentsByRepo.delete(store.key(owner, repoName));
        for (const key of [...mergeCommitShas.keys()]) {
          if (key.startsWith(`${store.key(owner, repoName)}#`)) mergeCommitShas.delete(key);
        }
        return empty(204);
      }
      return notFound();
    }
    if (repo === undefined) return notFound('Not Found');

    // ---- branches ----
    if (tail.length === 1 && tail[0] === 'branches' && m === 'GET') {
      const branches: unknown[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
          protected: false,
        });
      }
      const { items, link } = pageOf(branches, `/api/v3/repos/${owner}/${repoName}/branches`, {});
      return json(200, items, link !== null ? { link } : {});
    }

    // ---- git/refs (branch create) ----
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && m === 'POST') {
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (ref === undefined || !ref.startsWith('refs/heads/') || sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) {
        return err(422, 'Invalid ref or sha');
      }
      const obj = store.getObject(repo, sha.toLowerCase());
      if (obj === undefined || obj.type !== 'commit') return err(422, 'Object does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha.toLowerCase());
      return json(201, {
        ref,
        node_id: '',
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha: sha.toLowerCase(), type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha.toLowerCase()}` },
      });
    }

    // ---- commits ----
    if (tail.length === 1 && tail[0] === 'commits' && m === 'GET') {
      const refParam = query.get('sha') ?? undefined;
      const tip = resolveCommit(repo, refParam);
      if (tip === undefined) return json(200, []);
      const shas = walkCommits(repo, tip);
      const entries = shas.map((sha) => commitJson(repo, sha)).filter((e): e is Record<string, unknown> => e !== null);
      const params: Record<string, string> = {};
      if (refParam !== undefined) params.sha = refParam;
      const { items, link } = pageOf(entries, `/api/v3/repos/${owner}/${repoName}/commits`, params);
      return json(200, items, link !== null ? { link } : {});
    }

    // ---- contents ----
    if (tail.length >= 2 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (m === 'GET') {
        const refParam = query.get('ref') ?? undefined;
        const tip = resolveCommit(repo, refParam);
        if (tip === undefined) return notFound('Not Found');
        const files = flatFiles(repo, tip);
        if (files.has(filePath)) {
          const blobSha = files.get(filePath) as string;
          const blob = store.getObject(repo, blobSha);
          const data = blob !== undefined ? blob.data : Buffer.alloc(0);
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: data.toString('base64'),
            sha: blobSha,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`,
            download_url: null,
            _links: { self: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, git: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`, html: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}` },
          });
        }
        // Directory listing (or root when filePath is empty).
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const names = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
        for (const [p, blobSha] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          if (restPath === '') continue;
          const slash = restPath.indexOf('/');
          if (slash === -1) {
            const blob = store.getObject(repo, blobSha);
            names.set(restPath, { type: 'file', sha: blobSha, size: blob !== undefined ? blob.data.length : 0 });
          } else {
            const dirName = restPath.slice(0, slash);
            if (!names.has(dirName)) {
              const dirSha = treeShaForDir(repo, tip, filePath === '' ? dirName : `${filePath}/${dirName}`);
              names.set(dirName, { type: 'dir', sha: dirSha ?? '', size: 0 });
            }
          }
        }
        if (names.size === 0) return notFound('Not Found');
        const entries = [...names.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([name, info]) => ({
            type: info.type,
            size: info.size,
            name,
            path: prefix + name,
            sha: info.sha,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${prefix}${name}`,
            html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${prefix}${name}`,
            git_url: `/api/v3/repos/${owner}/${repoName}/git/trees/${info.sha}`,
            download_url: info.type === 'file' ? null : null,
            _links: { self: `/api/v3/repos/${owner}/${repoName}/contents/${prefix}${name}`, git: `/api/v3/repos/${owner}/${repoName}/git/trees/${info.sha}`, html: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${prefix}${name}` },
          }));
        return json(200, entries);
      }
      if (m === 'PUT') {
        const branch = str(input.branch) ?? repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (tip === undefined && branch !== repo.defaultBranch) return notFound('Not Found');
        const contentB64 = str(input.content);
        if (contentB64 === undefined) return err(422, 'content is required');
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const files = tip !== undefined ? flatFiles(repo, tip) : new Map<string, string>();
        const existed = files.has(filePath);
        const currentSha = files.get(filePath);
        const givenSha = str(input.sha);
        if (givenSha !== undefined && existed && givenSha.toLowerCase() !== (currentSha ?? '').toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        const blobSha = store.putObject(repo, 'blob', contentBytes);
        const next = new Map(files);
        next.set(filePath, blobSha);
        const treeSha = buildTreeFromFlat(store, repo, next);
        const message = str(input.message) ?? `Update ${filePath}`;
        const commitSha = createCommit(store, repo, treeSha, tip !== undefined ? [tip] : [], message);
        repo.refs.set(branchRef, commitSha);
        const at = store.now();
        repo.updatedAt = at;
        repo.pushedAt = at;
        return json(existed ? 200 : 201, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: blobSha,
            size: contentBytes.length,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`,
            download_url: null,
            type: 'file',
            content: contentBytes.toString('base64'),
            encoding: 'base64',
            _links: { self: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, git: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`, html: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}` },
          },
          commit: { sha: commitSha, message, author: { name: VIEWER.login, email: VIEWER.email, date: at }, committer: { name: VIEWER.login, email: VIEWER.email, date: at } },
        });
      }
      if (m === 'DELETE') {
        const branch = str(input.branch) ?? repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (tip === undefined) return notFound('Not Found');
        const files = flatFiles(repo, tip);
        if (!files.has(filePath)) return notFound('Not Found');
        const currentSha = files.get(filePath) as string;
        const givenSha = str(input.sha);
        if (givenSha !== undefined && givenSha.toLowerCase() !== currentSha.toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        const next = new Map(files);
        next.delete(filePath);
        const treeSha = buildTreeFromFlat(store, repo, next);
        const message = str(input.message) ?? `Delete ${filePath}`;
        const commitSha = createCommit(store, repo, treeSha, [tip], message);
        repo.refs.set(branchRef, commitSha);
        const at = store.now();
        repo.updatedAt = at;
        repo.pushedAt = at;
        return json(200, {
          content: null,
          commit: { sha: commitSha, message, author: { name: VIEWER.login, email: VIEWER.email, date: at }, committer: { name: VIEWER.login, email: VIEWER.email, date: at } },
        });
      }
      return notFound();
    }

    // ---- labels ----
    if (tail.length === 1 && tail[0] === 'labels') {
      if (m === 'GET') {
        const { items, link } = pageOf(repo.labels.map(labelJson), `/api/v3/repos/${owner}/${repoName}/labels`, {});
        return json(200, items, link !== null ? { link } : {});
      }
      if (m === 'POST') {
        const name = str(input.name);
        if (name === undefined || name === '') return err(422, 'name is required');
        const existing = repo.labels.find((l) => l.name === name);
        if (existing !== undefined) return json(201, labelJson(existing));
        const label: Label = {
          id: store.nextLabelId++,
          name,
          color: str(input.color) ?? '000000',
          description: str(input.description) ?? '',
          default: false,
        };
        repo.nextLabelId = store.nextLabelId;
        repo.labels.push(label);
        return json(201, labelJson(label));
      }
      return notFound();
    }

    // ---- issues ----
    if (tail.length >= 1 && tail[0] === 'issues') {
      // /issues (list / create)
      if (tail.length === 1) {
        if (m === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const labelsParam = query.get('labels');
          if (labelsParam !== null && labelsParam !== '') {
            const wanted = labelsParam.split(',').map((s) => s.trim());
            list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
          }
          list.sort((a, b) => {
            const av = sort === 'updated' ? a.updatedAt : a.createdAt;
            const bv = sort === 'updated' ? b.updatedAt : b.createdAt;
            const cmp = av < bv ? -1 : av > bv ? 1 : a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
          const params: Record<string, string> = {};
          if (query.get('state') !== null) params.state = state;
          if (query.get('sort') !== null) params.sort = sort;
          if (query.get('direction') !== null) params.direction = direction;
          if (query.get('per_page') !== null) params.per_page = query.get('per_page') as string;
          const { items, link } = pageOf(list.map((i) => issueJson(repo, i)), `/api/v3/repos/${owner}/${repoName}/issues`, params);
          return json(200, items, link !== null ? { link } : {});
        }
        if (m === 'POST') {
          const title = str(input.title) ?? '';
          const labelsInput = labelsFromInput(input.labels);
          for (const name of labelsInput) {
            if (!repo.labels.some((l) => l.name === name)) return err(422, `Label does not exist: ${name}`);
          }
          const at = store.now();
          const issue: Issue = {
            id: store.nextIssueId++,
            number: repo.nextIssueNumber++,
            title,
            body: str(input.body) ?? '',
            state: 'open',
            labels: labelsInput,
            userLogin: VIEWER.login,
            userId: VIEWER.id,
            createdAt: at,
            updatedAt: at,
            closedAt: null,
          };
          repo.issues.push(issue);
          return json(201, issueJson(repo, issue));
        }
        return notFound();
      }
      // /issues/{n} and /issues/{n}/comments
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) return notFound();
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (issue === undefined) return notFound('Not Found');
        if (m === 'GET') return json(200, issueJson(repo, issue));
        if (m === 'PATCH') {
          const t = str(input.title);
          if (t !== undefined) issue.title = t;
          const b = str(input.body);
          if (b !== undefined) issue.body = b;
          const s = str(input.state);
          if (s === 'closed' || s === 'open') {
            if (s === 'closed' && issue.state !== 'closed') issue.closedAt = store.now();
            if (s === 'open') issue.closedAt = null;
            issue.state = s;
          }
          if (input.labels !== undefined) {
            const labelsInput = labelsFromInput(input.labels);
            for (const name of labelsInput) {
              if (!repo.labels.some((l) => l.name === name)) return err(422, `Label does not exist: ${name}`);
            }
            issue.labels = labelsInput;
          }
          issue.updatedAt = store.now();
          return json(200, issueJson(repo, issue));
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return notFound('Not Found');
        const key = store.key(owner, repoName);
        if (m === 'GET') {
          const all = (commentsByRepo.get(key) ?? []).filter((c) => c.issueNumber === num);
          const { items, link } = pageOf(all.map(commentJson), `/api/v3/repos/${owner}/${repoName}/issues/${num}/comments`, {});
          return json(200, items, link !== null ? { link } : {});
        }
        if (m === 'POST') {
          const text = str(input.body) ?? '';
          const at = store.now();
          const comment: StoredComment = { id: nextCommentId++, issueNumber: num, body: text, userLogin: VIEWER.login, userId: VIEWER.id, createdAt: at, updatedAt: at };
          const list = commentsByRepo.get(key) ?? [];
          list.push(comment);
          commentsByRepo.set(key, list);
          return json(201, commentJson(comment));
        }
        return notFound();
      }
      return notFound();
    }

    // ---- pulls ----
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (m === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          const params: Record<string, string> = {};
          if (query.get('state') !== null) params.state = state;
          if (query.get('per_page') !== null) params.per_page = query.get('per_page') as string;
          const { items, link } = pageOf(list.map((p) => pullJson(store, repo, p)), `/api/v3/repos/${owner}/${repoName}/pulls`, params);
          return json(200, items, link !== null ? { link } : {});
        }
        if (m === 'POST') {
          const headRef = headBranchName(str(input.head));
          const baseRef = headBranchName(str(input.base)) ?? repo.defaultBranch;
          const headTip = repo.refs.get(`refs/heads/${headRef}`);
          const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
          if (headRef === undefined || headTip === undefined || baseTip === undefined) {
            return err(422, 'head or base branch does not exist');
          }
          const at = store.now();
          const files = diffPaths(repo, baseTip, headTip);
          const pr: PullRequest = {
            id: store.nextPullId++,
            number: repo.nextPullNumber++,
            title: str(input.title) ?? '',
            body: str(input.body) ?? '',
            state: 'open',
            merged: false,
            headRef,
            baseRef,
            headSha: headTip,
            baseSha: baseTip,
            mergeable: !isConflicted(repo, headRef, baseRef, headTip, baseTip),
            userLogin: VIEWER.login,
            userId: VIEWER.id,
            createdAt: at,
            updatedAt: at,
            mergedAt: null,
            files,
          };
          repo.pulls.push(pr);
          return json(201, pullJson(store, repo, pr));
        }
        return notFound();
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) return notFound();
      const pr = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (pr === undefined) return notFound('Not Found');
        if (m === 'GET') return json(200, pullJson(store, repo, pr));
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'files' && m === 'GET') {
        if (pr === undefined) return notFound('Not Found');
        const baseFiles = flatFiles(repo, pr.baseSha);
        const headFiles = flatFiles(repo, pr.headSha);
        const out: unknown[] = [];
        for (const filename of pr.files) {
          const inBase = baseFiles.has(filename);
          const inHead = headFiles.has(filename);
          const status = inBase && inHead ? 'modified' : inHead ? 'added' : 'removed';
          const oldText = inBase ? blobText(repo, baseFiles.get(filename) as string) : '';
          const newText = inHead ? blobText(repo, headFiles.get(filename) as string) : '';
          const { additions, deletions } = lineDiff(oldText, newText);
          out.push({
            sha: inHead ? headFiles.get(filename) : baseFiles.get(filename),
            filename,
            status,
            additions,
            deletions,
            changes: additions + deletions,
            blob_url: `https://github.com/${owner}/${repoName}/blob/${pr.headSha}/${filename}`,
            raw_url: `https://github.com/${owner}/${repoName}/raw/${pr.headSha}/${filename}`,
            contents_url: `/api/v3/repos/${owner}/${repoName}/contents/${filename}?ref=${pr.headSha}`,
            patch: undefined,
          });
        }
        const { items, link } = pageOf(out, `/api/v3/repos/${owner}/${repoName}/pulls/${num}/files`, {});
        return json(200, items, link !== null ? { link } : {});
      }
      if (tail.length === 3 && tail[2] === 'merge' && m === 'PUT') {
        if (pr === undefined) return notFound('Not Found');
        if (pr.merged || pr.state === 'closed') return err(405, 'Pull Request is already merged or closed');
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        if (baseTip === undefined) return notFound('Not Found');
        if (isConflicted(repo, pr.headRef, pr.baseRef, headTip, baseTip)) {
          return err(405, 'Merge conflict');
        }
        const headCommit = store.getObject(repo, headTip);
        const headTree = headCommit !== undefined && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
        if (headTree === '') return err(422, 'Head commit has no tree');
        const message = str(input.commit_message) ?? `Merge pull request #${pr.number} from ${pr.headRef}`;
        const squashSha = createCommit(store, repo, headTree, [baseTip], message);
        repo.refs.set(`refs/heads/${pr.baseRef}`, squashSha);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = store.now();
        pr.updatedAt = pr.mergedAt;
        mergeCommitShas.set(`${store.key(owner, repoName)}#${pr.number}`, squashSha);
        const at = store.now();
        repo.updatedAt = at;
        repo.pushedAt = at;
        return json(200, { sha: squashSha, merged: true, message: 'Pull Request successfully merged' });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Helpers

interface StoredComment {
  id: number;
  issueNumber: number;
  body: string;
  userLogin: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
}

const commentsByRepo = new Map<string, StoredComment[]>();
const mergeCommitShas = new Map<string, string>();
let nextCommentId = 50000;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return undefined;
}

/** Absolute origin for Link headers, from the Host header when present. */
function originOf(headers: Record<string, string | undefined>): string {
  const host = headerValue(headers, 'host') ?? headerValue(headers, 'x-forwarded-host');
  if (host === undefined || host === '') return '';
  return `http://${host}`;
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: '',
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: VIEWER.type,
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, avatar_url: '', type: 'User', site_admin: false },
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: '',
    url: `/api/v3/labels/${label.name}`,
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

function labelsFromInput(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      out.push((item as Record<string, unknown>).name as string);
    }
  }
  return out;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels.map((name) => {
    const found = repo.labels.find((l) => l.name === name);
    return found !== undefined ? labelJson(found) : { id: 0, name, color: '000000', default: false, description: '' };
  });
  return {
    id: issue.id,
    node_id: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: issue.userLogin, id: issue.userId, type: 'User', site_admin: false },
    labels,
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (commentsByRepo.get(`${repo.owner}/${repo.name}`) ?? []).filter((c) => c.issueNumber === issue.number).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function commentJson(comment: StoredComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: '',
    url: `/api/v3/comments/${comment.id}`,
    html_url: `https://github.com/issues/${comment.id}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.userLogin, id: comment.userId, type: 'User', site_admin: false },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const mergeSha = mergeCommitShas.get(`${store.key(repo.owner, repo.name)}#${pr.number}`) ?? null;
  return {
    id: pr.id,
    node_id: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user: { login: pr.userLogin, id: pr.userId, type: 'User', site_admin: false },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.mergedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: mergeSha,
    merged: pr.merged,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable ? 'clean' : 'dirty',
    merged_by: pr.merged ? { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false } : null,
    head: {
      label: `${VIEWER.login}:${pr.headRef}`,
      ref: pr.headRef,
      sha: pr.headSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false },
      repo: repoJson(repo),
    },
    base: {
      label: `${VIEWER.login}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: pr.baseSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false },
      repo: repoJson(repo),
    },
    author_association: 'OWNER',
    draft: false,
  };
}

/** `owner:branch` or plain `branch` -> the branch name. */
function headBranchName(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

// ---------------------------------------------------------------------------------------------
// Git objects (standard layout, git-compatible)

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

function parseCommit(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(store: Store, repo: Repo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return store.putObject(repo, 'tree', Buffer.concat(parts));
}

/** Flat path -> blob sha for the tree at `commitSha`. */
function flatFiles(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return out;
  const walk = (treeSha: string, prefix: string): void => {
    const tree = repo.objects.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const p = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, p);
      else out.set(p, entry.oid);
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}

/** Build nested trees for a flat path -> blob map; returns the root tree sha. */
function buildTreeFromFlat(store: Store, repo: Repo, files: Map<string, string>): string {
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, string>>();
    for (const [p, blobSha] of files) {
      if (prefix !== '' && !p.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? p : p.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: rest, oid: blobSha });
      } else {
        const dir = rest.slice(0, slash);
        let sub = subdirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          subdirs.set(dir, sub);
        }
        sub.set(rest.slice(slash + 1), blobSha);
      }
    }
    for (const dir of subdirs.keys()) {
      entries.push({ mode: '40000', name: dir, oid: buildDir(prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    return buildTree(store, repo, entries);
  };
  return buildDir('');
}

/** The tree sha of `dirPath` inside `commitSha`'s tree ('' = root tree). */
function treeShaForDir(repo: Repo, commitSha: string, dirPath: string): string | null {
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeSha = parseCommit(commit.data).tree;
  if (dirPath === '') return treeSha;
  for (const part of dirPath.split('/')) {
    const tree = repo.objects.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    treeSha = entry.oid;
  }
  return treeSha;
}

function createCommit(store: Store, repo: Repo, treeSha: string, parents: string[], message: string): string {
  const ts = store.nowUnix();
  const who = `${VIEWER.login} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
  return store.putObject(repo, 'commit', data);
}

/** Resolve a branch name, full ref or commit sha to a commit sha. */
function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = repo.objects.get(ref.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
  }
  return undefined;
}

/** Commit shas reachable from `tip`, newest first (BFS over parents). */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(sha);
    for (const p of parseCommit(obj.data).parents) {
      if (!seen.has(p)) queue.push(p);
    }
  }
  return out;
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const person = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (m === null) return { name: VIEWER.login, email: VIEWER.email, date: '2025-01-01T00:00:00Z' };
    return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = person(parsed.author);
  const committer = person(parsed.committer);
  return {
    sha,
    node_id: '',
    commit: {
      author,
      committer,
      message: parsed.message,
      tree: { sha: parsed.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false },
    parents: parsed.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

function blobText(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  return obj !== undefined && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

/** Paths whose blob differs between two commits. */
function diffPaths(repo: Repo, baseSha: string, headSha: string): string[] {
  const base = flatFiles(repo, baseSha);
  const head = flatFiles(repo, headSha);
  const out: string[] = [];
  const all = new Set([...base.keys(), ...head.keys()]);
  for (const p of all) {
    if (base.get(p) !== head.get(p)) out.push(p);
  }
  out.sort();
  return out;
}

/** Three-way conflict: a path changed on both sides of the merge-base, differently. */
function isConflicted(repo: Repo, headRef: string, baseRef: string, headTip: string, baseTip: string): boolean {
  void headRef;
  void baseRef;
  const headAncestors = new Set(walkCommits(repo, headTip));
  let mergeBase: string | undefined;
  for (const sha of walkCommits(repo, baseTip)) {
    if (headAncestors.has(sha)) {
      mergeBase = sha;
      break;
    }
  }
  if (mergeBase === undefined) return false;
  const ancestorFiles = flatFiles(repo, mergeBase);
  const headFiles = flatFiles(repo, headTip);
  const baseFiles = flatFiles(repo, baseTip);
  const all = new Set([...ancestorFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const p of all) {
    const a = ancestorFiles.get(p);
    const h = headFiles.get(p);
    const b = baseFiles.get(p);
    if (h !== a && b !== a && h !== b) return true;
  }
  return false;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = countLines(oldText);
  const newCounts = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
  for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}
