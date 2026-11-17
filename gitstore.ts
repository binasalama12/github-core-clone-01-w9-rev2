// SPDX-License-Identifier: MIT
// The git object engine of the forge: object hashing, commit/tree/tag
// parsing and building, packfile read/write, pkt-line framing, reachability
// walks and the fetch planner. Everything here works on one repository's
// object store and knows nothing about HTTP.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function parseCommitData(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function parseTagTarget(data: Buffer): string {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeNameKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeNameKey(a), 'utf8');
    const kb = Buffer.from(treeNameKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommitData(tree: string, parents: string[], message: string, ident: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

// ---------------------------------------------------------------------------
// The per-repository object store, with memoised parses for the hot walks.
// ---------------------------------------------------------------------------

export class GitStore {
  readonly objects = new Map<string, GitObject>();
  private commitParses = new Map<string, ParsedCommit>();
  private treeParses = new Map<string, TreeEntry[]>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  commit(oid: string): ParsedCommit | null {
    const cached = this.commitParses.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommitData(object.data);
    this.commitParses.set(oid, parsed);
    return parsed;
  }

  tree(oid: string): TreeEntry[] | null {
    const cached = this.treeParses.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    const parsed = parseTreeData(object.data);
    this.treeParses.set(oid, parsed);
    return parsed;
  }

  /** The commit oid a (possibly annotated, possibly nested) tag points at. */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return current;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return current;
      current = parseTagTarget(object.data);
    }
    return current;
  }

  /**
   * Every object reachable from `roots`. When `stopCommits` is given, a commit
   * in that set is included with its tree and blobs but its parents are not
   * followed (the shallow-boundary rule for what a client already holds).
   */
  reachable(roots: Iterable<string>, stopCommits?: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const root of roots) stack.push(root);
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const parsed = this.commit(oid);
        if (parsed === null) continue;
        stack.push(parsed.tree);
        if (stopCommits === undefined || !stopCommits.has(oid)) {
          for (const parent of parsed.parents) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        const entries = this.tree(oid);
        if (entries === null) continue;
        for (const entry of entries) {
          if (entry.mode === '160000') continue;
          stack.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        const target = parseTagTarget(object.data);
        if (target !== '') stack.push(target);
      }
    }
    return seen;
  }

  /** True when `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const parsed = this.commit(oid);
      if (parsed === null) continue;
      for (const parent of parsed.parents) stack.push(parent);
    }
    return false;
  }

  /** All commit ancestors of `tip`, including `tip` itself. */
  commitAncestors(tip: string): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const parsed = this.commit(oid);
      if (parsed === null) continue;
      seen.add(oid);
      for (const parent of parsed.parents) stack.push(parent);
    }
    return seen;
  }

  /** The best common ancestor of two commits, or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = this.commitAncestors(a);
    if (ancestorsOfA.has(b)) return b;
    if (this.commitAncestors(b).has(a)) return a;
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const parsed = this.commit(oid);
      if (parsed === null) continue;
      for (const parent of parsed.parents) queue.push(parent);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse one pkt-line at `offset`; returns the packet and the offset after it. */
export function readPkt(buf: Buffer, offset: number): { pkt: Pkt; next: number } {
  if (offset + 4 > buf.length) throw new Error('pkt-line: truncated header');
  const hex = buf.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`pkt-line: bad length ${JSON.stringify(hex)}`);
  const length = Number.parseInt(hex, 16);
  if (length === 0) return { pkt: { kind: 'flush', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 1) return { pkt: { kind: 'delim', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 2) return { pkt: { kind: 'end', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 3 || length > 65520) throw new Error(`pkt-line: bad length ${length}`);
  if (offset + length > buf.length) throw new Error('pkt-line: truncated payload');
  return { pkt: { kind: 'data', payload: buf.subarray(offset + 4, offset + length) }, next: offset + length };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Serialise whole objects (never deltas) into a version-2 packfile. */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset` in one call: with `info: true`
 * the engine reports exactly how many input bytes the stream consumed, so a
 * pack walk never guesses where the next entry begins.
 */
export function inflateOnce(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`pack: zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta buffer to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('pack: delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      delta.copy(out, written, offset, offset + count);
      offset += count;
      written += count;
    } else {
      throw new Error('pack: delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('pack: delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/**
 * Read a packfile and resolve every object in it. OFS_DELTA and REF_DELTA
 * entries are resolved against the pack itself and, for a thin pack, against
 * `external` (objects the store already holds).
 */
export function readPack(
  pack: Buffer,
  external?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack: too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== expected) throw new Error('pack: checksum mismatch');

  const entries: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack: unknown type code ${typeCode}`);
    }
    const inflated = inflateOnce(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack: entry size mismatch');
    offset = inflated.next;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: inflated.data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack: trailing bytes');

  const resolved = new Map<string, GitObject>();
  const byEntry = new Map<RawPackEntry, GitObject>();
  const resolve = (entry: RawPackEntry): GitObject => {
    const done = byEntry.get(entry);
    if (done !== undefined) return done;
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('pack: ofs-delta base missing');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      let base: GitObject | undefined;
      for (const candidate of byEntry.values()) {
        if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
          base = candidate;
          break;
        }
      }
      if (base === undefined) base = external?.(entry.baseOid);
      if (base === undefined) throw new Error('pack: ref-delta base missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPE[entry.typeCode] as ObjType, data: entry.data };
    }
    byEntry.set(entry, object);
    resolved.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of entries) resolve(entry);
  return resolved;
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Object ids to pack, commits first, then trees, then blobs and tags. */
  send: string[];
  /** Boundary commits the client must newly treat as shallow. */
  shallow: string[];
  /** Previously shallow commits whose parents are all held after this fetch. */
  unshallow: string[];
}

/**
 * Plan one fetch: the exact closure of the wants, cut at `depth` generations
 * when given, minus everything the haves already prove the client holds.
 * Objects reachable from a shallow have are excluded only down to that
 * boundary — the client does not hold its parents.
 */
export function planFetch(
  store: GitStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const haveObjects = new Set<string>();
  for (const have of haves) {
    if (!store.has(have)) continue;
    for (const oid of store.reachable([have], shallowSet)) haveObjects.add(oid);
  }

  // Phase 1: the commits to include, by generation from the wants.
  const generations = new Map<string, number>();
  const directObjects: string[] = [];
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      queue.push({ oid: want, gen: 1 });
    } else if (object.type === 'tag') {
      directObjects.push(want);
      queue.push({ oid: store.peelToCommit(want), gen: 1 });
    } else {
      directObjects.push(want);
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (depth !== null && gen > depth) continue;
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    const parsed = store.commit(oid);
    if (parsed === null) continue;
    generations.set(oid, gen);
    for (const parent of parsed.parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // Phase 2: the full tree/blob closure of every included commit and of any
  // directly wanted non-commit object. A commit contributes itself and its
  // tree closure only — its parents are phase 1's business, gated by depth.
  const included = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (included.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tree') {
        included.add(oid);
        const entries = store.tree(oid);
        if (entries === null) continue;
        for (const entry of entries) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } else if (object.type === 'blob') {
        included.add(oid);
      }
    }
  };
  for (const commitOid of generations.keys()) {
    included.add(commitOid);
    const parsed = store.commit(commitOid);
    if (parsed !== null) addTreeClosure(parsed.tree);
  }
  for (const oid of directObjects) {
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      // The tag chain itself; the target commit is already a phase-1 root.
      let current = oid;
      for (let guard = 0; guard < 16; guard += 1) {
        included.add(current);
        const currentObject = store.get(current);
        if (currentObject === undefined || currentObject.type !== 'tag') break;
        current = parseTagTarget(currentObject.data);
        if (current === '') break;
      }
    } else {
      for (const reached of store.reachable([oid])) included.add(reached);
    }
  }

  const sendSet = new Set<string>();
  for (const oid of included) {
    if (!haveObjects.has(oid)) sendSet.add(oid);
  }

  // Phase 3: the shallow bookkeeping over the client's resulting graph.
  // The client holds the full ancestor closure of its haves, not just the
  // have tips — a sent commit whose parent is only reachable through a have
  // is connected, not a shallow boundary.
  const heldCommits = new Set<string>();
  for (const oid of haveObjects) {
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') heldCommits.add(oid);
  }
  for (const oid of shallowSet) heldCommits.add(oid);
  const sentCommits: string[] = [];
  for (const oid of sendSet) {
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      heldCommits.add(oid);
      sentCommits.push(oid);
    }
  }
  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const parsed = store.commit(oid);
    if (parsed === null || parsed.parents.length === 0) continue;
    if (parsed.parents.some((parent) => !heldCommits.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    const parsed = store.commit(oid);
    if (parsed === null) continue;
    if (!heldCommits.has(oid)) continue;
    if (parsed.parents.every((parent) => heldCommits.has(parent))) unshallow.push(oid);
  }

  const commits: string[] = [];
  const trees: string[] = [];
  const rest: string[] = [];
  for (const oid of sendSet) {
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') commits.push(oid);
    else if (object.type === 'tree') trees.push(oid);
    else rest.push(oid);
  }
  return { send: [...commits, ...trees, ...rest], shallow, unshallow };
}
