# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zfamsz/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zfamsz/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, no dependencies, no git binary, no network. It serves git smart HTTP (protocol v2 upload-pack, v0 receive-pack with report-status and side-band-64k), REST API v3 (`/api/v3`), GraphQL API v4 (`/api/graphql`) and the MCP endpoint (`/mcp`, Streamable HTTP, revision 2026-07-28) — all against one in-memory store with deterministic state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the make.fun environment (`POST $MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` until the trial ends and exits 0. `MAKEFUN_SHOP_TOKEN` is the Bearer token every API route requires (except `/healthz` and the public REST root).

## Layout

- `main.ts` — the entry lifecycle (bind, register, poll `/done`, exit 0). Do not edit.
- `app.ts` — the HTTP server: routing, auth, request ids, JSON 404s.
- `src/store.ts` — the model: users, repos, refs, objects, issues, pulls, labels, comments, reviews. A logical clock (epoch 2025-01-01, +1 s per call) keeps state exports byte-identical across runs.
- `src/git.ts` — git smart HTTP: pack write (full objects, no deltas) and read (v2/v3, OFS/REF_DELTA, thin packs), v2 ls-refs/fetch with shallow/deepen, v0 receive-pack.
- `src/rest.ts` — REST v3: repos, issues, pulls, contents, labels, branches, commits, comments, reviews.
- `src/graphql.ts` — GraphQL v4: viewer, repository, issues, pull requests, mutations, `node(id:)`, batched operations.
- `src/mcp.ts` — MCP: `server/discover`, `initialize`, `tools/list`, `tools/call` (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request).

## Scores (local conformance runner, kit `sdk/run.ts`)

- 120/120 checks: git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15.
- Perf (local): feature 600, agent 200, perf 109 — total 909/1000.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zfamsz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
