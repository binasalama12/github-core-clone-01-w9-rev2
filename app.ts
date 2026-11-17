// SPDX-License-Identifier: MIT
// The HTTP front door: request routing, the git smart-HTTP protocol
// (upload-pack v2 + v0, receive-pack v0) and delegation to the REST,
// GraphQL and MCP surfaces. The git handlers sit on the benchmark's hot
// path, so they work on buffers end to end and cache fetch packs per repo.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, type Repo } from './core.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  pktLine,
  planFetch,
  readPack,
  readPkt,
  writePack,
  type GitObject,
} from './gitstore.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './gql.ts';
import { handleMcp } from './mcp.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer | string;
  headers?: Record<string, string>;
}

export interface HttpCtx {
  forge: Forge;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  host: string;
  token: string | null;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function jsonResult(status: number, value: unknown, headers?: Record<string, string>): HttpResult {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(value), headers };
}

export function errorResult(status: number, message: string): HttpResult {
  return jsonResult(status, { message });
}

function bearerToken(headers: IncomingMessage['headers']): string | null {
  const auth = headers.authorization;
  if (typeof auth !== 'string') return null;
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Whether the presented token is the trial token (when one is configured). */
export function tokenAccepted(ctx: HttpCtx): boolean {
  if (ctx.token === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  return ctx.token === expected;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 32 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createForgeServer(forge: Forge): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const ctx: HttpCtx = {
          forge,
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          host: req.headers.host ?? '127.0.0.1',
          token: bearerToken(req.headers),
        };
        const result = await route(ctx);
        writeResult(res, result);
      } catch {
        if (!res.headersSent) {
          writeResult(res, errorResult(500, 'Internal Server Error'));
        } else {
          res.end();
        }
      }
    })();
  });
  server.keepAliveTimeout = 5000;
  return server;
}

function writeResult(res: ServerResponse, result: HttpResult): void {
  const body = typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : result.body;
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': body.length,
    ...(result.headers ?? {}),
  });
  res.end(body);
}

async function route(ctx: HttpCtx): Promise<HttpResult> {
  const { path } = ctx;
  if (path === '/healthz') return jsonResult(200, { ok: true });
  if (path === '/api/v3' || path.startsWith('/api/v3/')) return handleRest(ctx);
  if (path === '/api/graphql') return handleGraphql(ctx);
  if (path === '/mcp') return handleMcp(ctx);
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const service = gitMatch[3] as string;
    if (service === 'info/refs') return infoRefs(ctx, owner, name);
    if (service === 'git-upload-pack') return uploadPack(ctx, owner, name);
    return receivePack(ctx, owner, name);
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS = 'side-band-64k ofs-delta shallow agent=sage-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=sage-forge/1.0';

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function infoRefs(ctx: HttpCtx, owner: string, name: string): HttpResult {
  const service = ctx.query.get('service');
  const repo = ctx.forge.getRepo(owner, name);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 403, contentType: 'text/plain; charset=utf-8', body: 'service not supported' };
  }
  if (repo === undefined) return errorResult(404, 'Not Found');
  const wantsV2 =
    service === 'git-upload-pack' &&
    typeof ctx.headers['git-protocol'] === 'string' &&
    (ctx.headers['git-protocol'] as string).includes('version=2');
  if (wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=sage-forge/1.0\n'),
      pktLine('ls-refs\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    let first = true;
    if (service === 'git-upload-pack') {
      const headOid = repo.refs.get(ctx.forge.branchRef(repo.defaultBranch)) ?? ZERO_OID;
      parts.push(pktLine(`${headOid} HEAD\0${caps}`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${caps}` : `${oid} ${ref}`));
      first = false;
      const object = repo.store.get(oid);
      if (service === 'git-upload-pack' && object !== undefined && object.type === 'tag') {
        parts.push(pktLine(`${repo.store.peelToCommit(oid)} ${ref}^{}`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

interface PktSections {
  sections: string[][];
  rest: Buffer;
}

/** Split a pkt-line request body into flush-terminated sections of text lines. */
function splitPktSections(body: Buffer, maxSections: number): PktSections {
  const sections: string[][] = [];
  let current: string[] = [];
  let offset = 0;
  while (offset < body.length && sections.length < maxSections) {
    const { pkt, next } = readPkt(body, offset);
    offset = next;
    if (pkt.kind === 'flush') {
      sections.push(current);
      current = [];
      if (sections.length >= maxSections) break;
    } else if (pkt.kind === 'delim') {
      sections.push(current);
      current = [];
    } else if (pkt.kind === 'data') {
      current.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  if (current.length > 0) sections.push(current);
  return { sections, rest: body.subarray(offset) };
}

function uploadPack(ctx: HttpCtx, owner: string, name: string): HttpResult {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return errorResult(404, 'Not Found');
  let parsed: PktSections;
  try {
    parsed = splitPktSections(ctx.body, 2);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'malformed pkt-line request' };
  }
  const commandLine = parsed.sections[0]?.find((line) => line.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length);
  const args = parsed.sections[1] ?? [];
  const isV2 =
    typeof ctx.headers['git-protocol'] === 'string' && (ctx.headers['git-protocol'] as string).includes('version=2');
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return fetchObjects(ctx, repo, args, isV2);
  // A v0 upload-pack request has no command line: its first section is wants.
  return fetchObjects(ctx, repo, [...(parsed.sections[0] ?? []), ...(parsed.sections[1] ?? [])], false);
}

function lsRefs(repo: NonNullable<ReturnType<Forge['getRepo']>>, args: string[]): HttpResult {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (refName: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (matches('HEAD')) {
    lines.push(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = repo.store.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${repo.store.peelToCommit(oid)}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const band = Buffer.from([1]);
  for (let offset = 0; offset < pack.length; offset += 32768) {
    parts.push(pktLine(Buffer.concat([band, pack.subarray(offset, offset + 32768)])));
  }
  return parts;
}

function fetchObjects(
  ctx: HttpCtx,
  repo: NonNullable<ReturnType<Forge['getRepo']>>,
  args: string[],
  isV2: boolean,
): HttpResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsedDepth = Number.parseInt(arg.slice(7).trim(), 10);
      depth = Number.isFinite(parsedDepth) ? parsedDepth : null;
    }
  }
  const cacheKey = `${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}|${isV2 ? 'v2' : 'v0'}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const plan = planFetch(repo.store, wants, haves, shallow, depth);
  const objects: GitObject[] = [];
  for (const oid of plan.send) {
    const object = repo.store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (isV2) {
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const acked = haves.find((have) => repo.store.has(have));
      parts.push(pktLine(acked !== undefined ? `ACK ${acked}\n` : 'NAK\n'));
      parts.push(pktLine('ready\n'));
      parts.push(PKT_DELIM);
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandChunks(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandChunks(pack));
    parts.push(PKT_FLUSH);
  }
  const body = Buffer.concat(parts);
  if (repo.packCache.size > 256) repo.packCache.clear();
  repo.packCache.set(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function receivePack(ctx: HttpCtx, owner: string, name: string): HttpResult {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return errorResult(404, 'Not Found');
  let parsed: PktSections;
  try {
    parsed = splitPktSections(ctx.body, 1);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'malformed pkt-line request' };
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const rawLine of parsed.sections[0] ?? []) {
    const line = rawLine.split('\0')[0] as string;
    const fields = line.split(' ');
    if (fields.length !== 3) {
      return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'malformed ref update' };
    }
    commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const rest = parsed.rest;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.store.get(oid));
      for (const [oid, object] of objects) repo.store.putKnown(oid, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }
  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (unpackOk) {
    for (const command of commands) {
      report.push(applyRefUpdate(repo, command));
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
  }
  const reportStream = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  const parts: Buffer[] = [];
  const band = Buffer.from([1]);
  for (let offset = 0; offset < reportStream.length; offset += 32768) {
    parts.push(pktLine(Buffer.concat([band, reportStream.subarray(offset, offset + 32768)])));
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(parts),
  };
}

/** Apply one receive-pack command; returns its report-status line. */
function applyRefUpdate(
  repo: NonNullable<ReturnType<Forge['getRepo']>>,
  command: { oldOid: string; newOid: string; ref: string },
): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) return `ng ${ref} invalid ref\n`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return `ng ${ref} reference not found\n`;
    repo.refs.delete(ref);
    return `ok ${ref}\n`;
  }
  const target = repo.store.get(newOid);
  if (target === undefined) return `ng ${ref} missing object\n`;
  if (current !== ZERO_OID && current !== oldOid) return `ng ${ref} stale info\n`;
  if (oldOid === ZERO_OID && current !== ZERO_OID && current !== newOid) {
    return `ng ${ref} reference already exists\n`;
  }
  if (current !== ZERO_OID && current !== newOid) {
    const targetIsCommit = target.type === 'commit' || target.type === 'tag';
    if (targetIsCommit && ref.startsWith('refs/heads/')) {
      const newCommit = target.type === 'tag' ? repo.store.peelToCommit(newOid) : newOid;
      if (!repo.store.isAncestor(current, newCommit)) return `ng ${ref} non-fast-forward\n`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}\n`;
}

export { VIEWER };
