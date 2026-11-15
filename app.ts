// Integrated forge server: one process, one Store, four surfaces.
// Routing: /healthz (no auth) -> git smart HTTP -> GraphQL -> MCP -> REST v3
// -> JSON 404. The lifecycle in main.ts is unchanged (bind ephemeral port,
// register with the env, poll /done, exit 0).
//
// Integration notes from the module workers:
// - REST builds absolute pagination Links from the request's Host header, so
//   the real headers (lowercased keys, including `host`) are passed through.
// - GraphQL/MCP delegate comments and merge SHAs to rest.ts via dynamic import;
//   Node caches the module, so rest.ts's module-level maps are shared.
// - Auth: every API route requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`
//   except /healthz (and REST's public /api/v3/ root and /meta, as rest.ts does).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

type HandlerResult = { status: number; headers: Record<string, string>; body: Buffer };

const store = new Store();
let requestCounter = 0;

function sendResult(res: ServerResponse, result: HandlerResult): void {
  const headers: Record<string, string> = { ...result.headers };
  if (!('content-length' in headers)) headers['content-length'] = String(result.body.length);
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  sendResult(res, {
    status,
    headers: { 'content-type': JSON_TYPE, ...headers },
    body: Buffer.from(text, 'utf8'),
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let path = '/';
      let query = new URLSearchParams();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        path = url.pathname;
        query = url.searchParams;
      } catch {
        // Keep '/' and empty query; never throw from a request.
      }
      const headers = lowerHeaders(req);
      const requestId = `req-${++requestCounter}`;
      const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const body = needsBody ? await readBody(req) : Buffer.alloc(0);

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      try {
        const git = await handleGit(store, method, path, query, headers, body, expectedToken);
        if (git !== null) {
          sendResult(res, git);
          return;
        }
        const gql = await handleGraphQL(store, method, path, query, headers, body, expectedToken, requestId);
        if (gql !== null) {
          sendResult(res, gql);
          return;
        }
        const mcp = await handleMcp(store, method, path, query, headers, body, expectedToken, requestId);
        if (mcp !== null) {
          sendResult(res, mcp);
          return;
        }
        const rest = await handleRest(store, method, path, query, headers, body, expectedToken, requestId);
        if (rest !== null) {
          sendResult(res, rest);
          return;
        }
      } catch (err) {
        // A handler must never take the server down (the suite's
        // repo-survives-errors check): answer 500 JSON and keep serving.
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, { 'x-github-request-id': requestId });
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    })().catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'internal error' });
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
  });
}
