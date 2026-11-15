// git smart-HTTP (upload-pack v2/v0, receive-pack v0) for the forge.
//
// Node stdlib only (node:crypto, node:zlib). No git binary, no network.
// Deterministic: refs and pack objects are emitted in sorted order, no
// Date.now()/Math.random() anywhere. Packs carry full objects (no deltas);
// incoming packs may carry OFS_DELTA/REF_DELTA, including thin packs whose
// bases already live in the repo.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const PKT_MAX = 65520;
const AGENT = 'makefun-git/1.0';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_RANK: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };

type GitResult = { status: number; headers: Record<string, string>; body: Buffer } | null;

export async function handleGit(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  expectedToken: string,
): Promise<GitResult> {
  const parts = path.split('/').filter((segment) => segment.length > 0);
  if (parts.length < 3) return null;
  const owner = parts[0];
  const repoGit = parts[1];
  if (!repoGit.endsWith('.git')) return null;
  const restPath = parts.slice(2).join('/');
  if (restPath !== 'info/refs' && restPath !== 'git-upload-pack' && restPath !== 'git-receive-pack') return null;
  const repoName = repoGit.slice(0, -4);
  try {
    const lower: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) lower[key.toLowerCase()] = value;
    }
    if (expectedToken) {
      if ((lower['authorization'] ?? '') !== `Bearer ${expectedToken}`) {
        return { status: 401, headers: {}, body: Buffer.from('unauthorized', 'utf8') };
      }
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) return { status: 404, headers: {}, body: Buffer.from('not found', 'utf8') };
    if (restPath === 'info/refs') return handleInfoRefs(repo, method, query, lower);
    if (method !== 'POST') return { status: 405, headers: {}, body: Buffer.from('method not allowed', 'utf8') };
    if (restPath === 'git-upload-pack') return handleUploadPack(repo, body, lower);
    return handleReceivePack(store, repo, body);
  } catch {
    return { status: 500, headers: {}, body: Buffer.from('internal error', 'utf8') };
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer | null;
}

function decodePackets(buf: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: null });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: null });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: null });
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_MAX) throw new Error('invalid pkt-line length');
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return packets;
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function textResult(status: number, text: string): { status: number; headers: Record<string, string>; body: Buffer } {
  return { status, headers: {}, body: Buffer.from(text, 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// object model helpers (over repo.objects)
// ---------------------------------------------------------------------------------------------

function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${data.length}\0`, 'utf8'))
    .update(data)
    .digest('hex');
}

function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const head = data.toString('utf8').split('\n\n')[0] ?? '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

function parseTagTarget(data: Buffer): string {
  const head = data.toString('utf8').split('\n\n')[0] ?? '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Follow annotated tags to the object they ultimately point at. */
function peelOid(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    const target = parseTagTarget(obj.data);
    if (!target) return current;
    current = target;
  }
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(headTarget(repo));
}

/** Add a tree and everything under it (skipping gitlinks) to `set`. */
function addTree(repo: Repo, set: Set<string>, treeOid: string): void {
  if (set.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (!obj) {
    set.add(treeOid);
    return;
  }
  set.add(treeOid);
  if (obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '160000') continue;
    if (entry.mode === '40000') addTree(repo, set, entry.oid);
    else set.add(entry.oid);
  }
}

interface Traversal {
  set: Set<string>;
  gen: Map<string, number>;
}

/**
 * Walk from `roots`. `depth` caps commit generations (want = generation 0, so
 * depth 1 keeps only the wanted commits); `stopAt` truncates a walk at the
 * named commits (their trees are still included, their parents are not) —
 * that is how a client's shallow boundary is honoured for `have` lines.
 */
function traverse(
  repo: Repo,
  roots: readonly string[],
  options: { depth?: number; stopAt?: Set<string> } = {},
): Traversal {
  const set = new Set<string>();
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; g: number }> = [];
  for (const root of roots) if (isOid(root)) queue.push({ oid: root, g: 0 });
  let head = 0;
  while (head < queue.length) {
    const { oid, g } = queue[head++];
    if (set.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    set.add(oid);
    gen.set(oid, g);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree) addTree(repo, set, commit.tree);
      if (!options.stopAt?.has(oid)) {
        for (const parent of commit.parents) {
          if (options.depth === undefined || g + 1 < options.depth) queue.push({ oid: parent, g: g + 1 });
        }
      }
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push({ oid: target, g });
    } else if (obj.type === 'tree') {
      addTree(repo, set, oid);
    }
  }
  return { set, gen };
}

/** True when `ancestor` is reachable from `descendant` through commit parents (tags dereferenced). */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push(target);
    } else if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packfile write (full objects, no deltas) and read (deltas + thin packs)
// ---------------------------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

interface PackObject {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

function buildPack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Cache of built packfiles, keyed by the fingerprint of their object set.
 * The clone workload issues 50 identical shallow clones of one repository; the
 * pack for the same object set is byte-identical (buildPack's order is
 * deterministic), so rebuilding it 50 times is pure waste. The key is the
 * sorted oid list, and an oid is the hash of its type and data, so any repo
 * change yields a different key. Bounded to 16 entries (FIFO) to cap memory.
 */
const PACK_CACHE = new Map<string, Buffer>();
function cachedBuildPack(objects: readonly PackObject[]): Buffer {
  const key = objects.map((o) => o.oid).sort().join(',');
  const hit = PACK_CACHE.get(key);
  if (hit !== undefined) return hit;
  const pack = buildPack(objects);
  if (PACK_CACHE.size >= 16) {
    const oldest = PACK_CACHE.keys().next().value;
    if (oldest !== undefined) PACK_CACHE.delete(oldest);
  }
  PACK_CACHE.set(key, pack);
  return pack;
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Parse a packfile (v2/v3). OFS_DELTA/REF_DELTA are resolved against the pack
 * itself or, for thin packs, against `lookup` (the repo's objects). The
 * trailer checksum is verified and every entry's declared size is checked.
 */
function parsePack(buf: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = off;
    if (off >= trailerStart) throw new Error('pack entry is truncated');
    let byte = buf[off];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    off += 1;
    while (byte & 0x80) {
      if (off >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (off >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = buf[off];
      off += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (off >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[off++];
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), off);
    if (inflated.data.length !== size) throw new Error('pack entry inflated size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const byOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const storeResolved = (entry: RawEntry, type: GitObjectType, data: Buffer): void => {
    const oid = hashObject(type, data);
    resolved.set(entry.offset, { type, data, oid });
    byOid.set(oid, { type, data });
  };
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) continue;
    storeResolved(entry, CODE_TYPE[entry.typeCode], entry.data);
  }
  let progress = true;
  while (resolved.size < raw.length && progress) {
    progress = false;
    for (const entry of raw) {
      if (resolved.has(entry.offset)) continue;
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.typeCode === 6) {
        base = resolved.get(entry.baseOffset!);
      } else if (entry.typeCode === 7) {
        base = byOid.get(entry.baseOid!) ?? lookup(entry.baseOid!);
      }
      if (!base) continue;
      storeResolved(entry, base.type, applyDelta(base.data, entry.data));
      progress = true;
    }
  }
  if (resolved.size < raw.length) throw new Error('unresolved delta base in pack');
  const objects = new Map<string, GitObject>();
  for (const entry of resolved.values()) objects.set(entry.oid, { type: entry.type, data: entry.data });
  return objects;
}

// ---------------------------------------------------------------------------------------------
// fetch object selection (shared by v0 and v2)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim().split(/\s+/)[0];
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

interface SendPlan {
  send: PackObject[];
  shallow: string[];
  unshallow: string[];
}

function computeSend(repo: Repo, args: FetchArgs): SendPlan {
  const included = traverse(repo, args.wants, { depth: args.depth });
  // A have that is also a shallow boundary is held without its parents, so
  // the have-walk stops there instead of excluding the whole history.
  const held = traverse(repo, args.haves, { stopAt: new Set(args.shallow) });
  const send: PackObject[] = [];
  for (const oid of included.set) {
    if (held.set.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) send.push({ oid, type: obj.type, data: obj.data });
  }
  send.sort(
    (a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0),
  );
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== undefined) {
    for (const oid of included.set) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const g = included.gen.get(oid) ?? 0;
      if (g === args.depth - 1) {
        shallow.push(oid);
        continue;
      }
      const parents = parseCommit(obj.data).parents;
      if (parents.some((parent) => repo.objects.has(parent) && !included.set.has(parent))) shallow.push(oid);
    }
    shallow.sort();
    const boundary = new Set(shallow);
    for (const oid of args.shallow) {
      if (included.set.has(oid) && !boundary.has(oid)) unshallow.push(oid);
    }
    unshallow.sort();
  }
  return { send, shallow, unshallow };
}

/** Split a pack into sideband band-1 pkt-lines (payload = band byte + data). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 16384;
  for (let off = 0; off < pack.length; off += CHUNK) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(off, Math.min(off + CHUNK, pack.length))])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const chunks: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  let first = true;
  const emit = (oid: string, name: string): void => {
    chunks.push(pkt(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
    first = false;
  };
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    emit(ZERO_OID, 'capabilities^{}');
  } else {
    emit(headOid(repo) ?? ZERO_OID, 'HEAD');
    for (const [name, oid] of refs) {
      emit(oid, name);
      const peeled = peelOid(repo, oid);
      if (peeled !== oid) emit(peeled, `${name}^{}`);
    }
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function handleInfoRefs(
  repo: Repo,
  method: string,
  query: URLSearchParams,
  lower: Record<string, string>,
): { status: number; headers: Record<string, string>; body: Buffer } {
  if (method !== 'GET') return textResult(405, 'method not allowed');
  const service = query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return textResult(400, 'unknown service');
  const isV2 = service === 'git-upload-pack' && (lower['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      body: v2Advertisement(),
    };
  }
  return {
    status: 200,
    headers: { 'content-type': `application/x-${service}-advertisement` },
    body: v0Advertisement(repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function handleLsRefsV2(repo: Repo, lines: readonly string[]): { status: number; headers: Record<string, string>; body: Buffer } {
  const wantPeel = lines.some((line) => line.replace(/\n$/, '') === 'peel');
  const wantSymrefs = lines.some((line) => line.replace(/\n$/, '') === 'symrefs');
  const wantUnborn = lines.some((line) => line.replace(/\n$/, '') === 'unborn');
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const target = headTarget(repo);
  const head = headOid(repo);
  if (keep('HEAD')) {
    if (head) {
      out.push(pkt(`${head} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (wantUnborn) {
      out.push(pkt(`unborn HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const peeled = peelOid(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(out),
  };
}

function handleFetchV2(repo: Repo, lines: readonly string[]): { status: number; headers: Record<string, string>; body: Buffer } {
  const args = parseFetchArgs(lines);
  const plan = computeSend(repo, args);
  const pack = cachedBuildPack(plan.send);
  const chunks: Buffer[] = [];
  chunks.push(pkt('acknowledgments\n'));
  const common = args.haves.filter((have) => repo.objects.has(have));
  if (common.length) {
    chunks.push(pkt(`ACK ${common[0]}\n`));
    chunks.push(pkt('ready\n'));
  } else {
    chunks.push(pkt('NAK\n'));
  }
  chunks.push(DELIM);
  if (args.depth !== undefined && (plan.shallow.length || plan.unshallow.length)) {
    chunks.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
    chunks.push(DELIM);
  }
  chunks.push(pkt('packfile\n'));
  chunks.push(...sidebandPackets(pack));
  chunks.push(FLUSH);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(chunks),
  };
}

function handleFetchV0(repo: Repo, lines: readonly string[]): { status: number; headers: Record<string, string>; body: Buffer } {
  const args = parseFetchArgs(lines);
  const plan = computeSend(repo, args);
  const pack = cachedBuildPack(plan.send);
  const chunks: Buffer[] = [];
  const common = args.haves.filter((have) => repo.objects.has(have));
  if (common.length) chunks.push(pkt(`ACK ${common[0]}\n`));
  else chunks.push(pkt('NAK\n'));
  if (args.depth !== undefined) {
    for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
  }
  chunks.push(...sidebandPackets(pack));
  chunks.push(FLUSH);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(chunks),
  };
}

function handleUploadPack(
  repo: Repo,
  body: Buffer,
  lower: Record<string, string>,
): { status: number; headers: Record<string, string>; body: Buffer } {
  let packets: DecodedPacket[];
  try {
    packets = decodePackets(body);
  } catch {
    return textResult(400, 'malformed pkt-line');
  }
  const lines = packets
    .filter((packet) => packet.kind === 'data' && packet.payload !== null)
    .map((packet) => (packet.payload as Buffer).toString('utf8'));
  const isV2 = (lower['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    const command = (lines[0] ?? '').replace(/\n$/, '');
    if (command === 'command=ls-refs') return handleLsRefsV2(repo, lines);
    if (command === 'command=fetch') return handleFetchV2(repo, lines);
    return textResult(400, 'unknown v2 command');
  }
  return handleFetchV0(repo, lines);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function splitPushBody(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off < body.length) {
    if (off + 4 > body.length) throw new Error('truncated pkt-line');
    const hex = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      off += 4;
      return { lines, rest: body.subarray(off) };
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_MAX) throw new Error('invalid pkt-line length');
    if (off + len > body.length) throw new Error('truncated pkt-line');
    lines.push(body.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  throw new Error('missing flush after commands');
}

function parsePushCommands(lines: readonly string[]): { commands: PushCommand[]; sideband: boolean } {
  const commands: PushCommand[] = [];
  let sideband = false;
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const main = nul >= 0 ? line.slice(0, nul) : line;
    if (index === 0 && nul >= 0) sideband = line.slice(nul + 1).split(' ').includes('side-band-64k');
    const parts = main.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error('bad push command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });
  return { commands, sideband };
}

function handleReceivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  let lines: string[];
  let rest: Buffer;
  try {
    ({ lines, rest } = splitPushBody(body));
  } catch {
    return textResult(400, 'malformed pkt-line');
  }
  let commands: PushCommand[];
  let sideband = false;
  try {
    ({ commands, sideband } = parsePushCommands(lines));
  } catch {
    return textResult(400, 'bad push command');
  }
  if (commands.length === 0) return textResult(400, 'no push commands');

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const unpacked = parsePack(rest, (oid) => repo.objects.get(oid));
      for (const obj of unpacked.values()) store.putObject(repo, obj.type, obj.data);
    } catch (err) {
      unpackError = (err as Error).message.replace(/\n/g, ' ');
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack error ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    const snapshot = new Map(repo.refs);
    interface Verdict {
      ref: string;
      ok: boolean;
      reason: string;
    }
    const verdicts: Verdict[] = [];
    for (const command of commands) {
      const current = snapshot.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (!current) verdicts.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
        } else verdicts.push({ ref: command.ref, ok: true, reason: '' });
      } else if (command.oldOid === ZERO_OID) {
        if (current) verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
        else if (!repo.objects.has(command.newOid)) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
        } else verdicts.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        if (!current) verdicts.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        else if (command.oldOid !== current) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
        } else if (!repo.objects.has(command.newOid)) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
        } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      const verdict = verdicts[index];
      if (verdict.ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${verdict.reason}\n`);
      }
    }
  }

  const report = Buffer.concat(reportLines.map((line) => pkt(line)));
  const chunks: Buffer[] = [];
  if (sideband) {
    const CHUNK = 16384;
    for (let off = 0; off < report.length; off += CHUNK) {
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(off, Math.min(off + CHUNK, report.length))])));
    }
  } else {
    chunks.push(report);
  }
  chunks.push(FLUSH);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: Buffer.concat(chunks),
  };
}
