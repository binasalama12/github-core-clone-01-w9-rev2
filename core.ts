// SPDX-License-Identifier: MIT
// The forge's state and service layer: repositories, refs, labels, issues,
// comments and pull requests over the git object store, plus the tree and
// merge machinery every surface (REST, GraphQL, MCP, git) shares.

import {
  GitStore,
  buildCommitData,
  buildTreeData,
  hashObject,
  type TreeEntry,
} from './gitstore.ts';

/** The one account the trial token names; every repository belongs to it. */
export const VIEWER = 'adaiversen';
export const VIEWER_ID = 1000;

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export class Repo {
  readonly store = new GitStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  readonly packCache = new Map<string, Buffer>();
  nextNumber = 1;
  nextCommentId = 1;
  readonly defaultBranch = 'main';
  readonly id: number;
  readonly name: string;
  readonly isPrivate: boolean;
  description: string;

  constructor(id: number, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }
}

const EMPTY_TREE = hashObject('tree', Buffer.alloc(0));

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private clock = 1700000000;

  /** A deterministic logical timestamp: request order is the only clock. */
  nowIso(): string {
    this.clock += 1;
    return new Date(this.clock * 1000).toISOString();
  }

  private ident(): string {
    this.clock += 1;
    return `${VIEWER} <${VIEWER}@localhost> ${this.clock} +0000`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /** A repository is visible only under its owner's login. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER) return undefined;
    return this.repos.get(name);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER) return false;
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  freshId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id + 100000;
  }

  // ------------------------------------------------------------ refs & trees

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(this.branchRef(branch)) ?? null;
  }

  /** Resolve a branch name or a raw commit id to a commit oid. */
  resolveCommit(repo: Repo, ref: string): string | null {
    const byBranch = this.branchTip(repo, ref);
    if (byBranch !== null) return byBranch;
    if (repo.store.commit(ref) !== null) return ref;
    return null;
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    const parsed = repo.store.commit(commitOid);
    return parsed === null ? null : parsed.tree;
  }

  /** Walk a tree to a path; answers the blob or subtree oid found there. */
  treeLookup(repo: Repo, treeOid: string, parts: string[]): { kind: 'blob' | 'tree'; oid: string } | null {
    let current = treeOid;
    for (let index = 0; index < parts.length; index += 1) {
      const entries = repo.store.tree(current);
      if (entries === null) return null;
      const entry = entries.find((candidate) => candidate.name === parts[index]);
      if (entry === undefined) return null;
      if (index === parts.length - 1) {
        return { kind: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { kind: 'tree', oid: current };
  }

  /** Every file in a tree as a flat path -> blob oid map. */
  flattenTree(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const entries = repo.store.tree(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Materialise a tree from a flat path -> blob oid map. */
  storeFlatTree(repo: Repo, flat: ReadonlyMap<string, string>): string {
    interface DirNode {
      files: Map<string, string>;
      dirs: Map<string, DirNode>;
    }
    const newNode = (): DirNode => ({ files: new Map(), dirs: new Map() });
    const root = newNode();
    for (const [path, oid] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index] as string;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = newNode();
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, oid);
    }
    const emit = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
      return repo.store.put('tree', buildTreeData(entries));
    };
    return emit(root);
  }

  /** Set or delete one path in a tree, rebuilding the spine; returns the new tree oid. */
  private treeSet(repo: Repo, treeOid: string | null, parts: string[], blobOid: string | null): string {
    const entries: TreeEntry[] = treeOid === null ? [] : [...(repo.store.tree(treeOid) ?? [])];
    const head = parts[0] as string;
    const at = entries.findIndex((entry) => entry.name === head);
    if (parts.length === 1) {
      if (at >= 0) entries.splice(at, 1);
      if (blobOid !== null) entries.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = at >= 0 ? entries[at] : undefined;
      const childOid = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      const newChild = this.treeSet(repo, childOid, parts.slice(1), blobOid);
      if (at >= 0) entries.splice(at, 1);
      if (newChild !== EMPTY_TREE) entries.push({ mode: '40000', name: head, oid: newChild });
    }
    return repo.store.put('tree', buildTreeData(entries));
  }

  /**
   * Commit one file change (or deletion, when `content` is null) on a branch.
   * A branch that does not exist yet is created from the default branch's tip;
   * on an unborn repository the commit is a root commit.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null } {
    const ref = this.branchRef(branch);
    const tip = repo.refs.get(ref) ?? null;
    let baseTree = EMPTY_TREE;
    let parents: string[] = [];
    if (tip !== null) {
      baseTree = this.commitTree(repo, tip) ?? EMPTY_TREE;
      parents = [tip];
    } else if (branch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(this.branchRef(repo.defaultBranch)) ?? null;
      if (defaultTip !== null) {
        baseTree = this.commitTree(repo, defaultTip) ?? EMPTY_TREE;
        parents = [defaultTip];
      }
    }
    const blobOid = content === null ? null : repo.store.put('blob', content);
    const newTree = this.treeSet(repo, baseTree, path.split('/'), blobOid);
    const commitOid = repo.store.put('commit', buildCommitData(newTree, parents, message, this.ident()));
    repo.refs.set(ref, commitOid);
    return { commitOid, blobOid };
  }

  // ------------------------------------------------------------- domain ops

  createLabel(repo: Repo, name: string, color: string): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { id: this.freshId(), name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const issue: Issue = {
      number: repo.nextNumber,
      id: this.freshId(),
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const headSha = this.branchTip(repo, headRef) ?? ZERO_FALLBACK;
    const baseSha = this.branchTip(repo, baseRef) ?? ZERO_FALLBACK;
    const pull: Pull = {
      number: repo.nextNumber,
      id: this.freshId(),
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headShaAtCreate: headSha,
      baseShaAtCreate: baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The current head/base tips of a pull request (live, as GitHub reports). */
  pullTips(repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
    return {
      headSha: this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate,
      baseSha: this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate,
    };
  }

  /** Files changed between a pull request's merge base and its head tip. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const { headSha } = this.pullTips(repo, pull);
    const baseSha = repo.store.mergeBase(headSha, pull.baseShaAtCreate) ?? pull.baseShaAtCreate;
    return this.diffCommits(repo, baseSha, headSha);
  }

  /** Whether merging the pull request right now would conflict. */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const { headSha, baseSha } = this.pullTips(repo, pull);
    return this.planMerge(repo, baseSha, headSha) !== null;
  }

  /**
   * Three-way merge of `headOid` into `baseOid` over their merge base.
   * Returns the merged flat tree, or null on a per-file conflict: a path the
   * head changed whose base-side version moved away from the merge base to
   * something that is neither the base nor the head version.
   */
  planMerge(repo: Repo, baseOid: string, headOid: string): Map<string, string> | null {
    const mergeBase = repo.store.mergeBase(baseOid, headOid) ?? baseOid;
    const baseTree = this.commitTree(repo, mergeBase);
    const currentTree = this.commitTree(repo, baseOid);
    const headTree = this.commitTree(repo, headOid);
    if (baseTree === null || currentTree === null || headTree === null) return null;
    const atBase = this.flattenTree(repo, baseTree);
    const atCurrent = this.flattenTree(repo, currentTree);
    const atHead = this.flattenTree(repo, headTree);
    const merged = new Map(atCurrent);
    const paths = new Set<string>([...atBase.keys(), ...atHead.keys()]);
    for (const path of paths) {
      const baseVersion = atBase.get(path);
      const headVersion = atHead.get(path);
      if (headVersion === baseVersion) continue;
      const currentVersion = atCurrent.get(path);
      if (currentVersion !== baseVersion && currentVersion !== headVersion) return null;
      if (headVersion === undefined) merged.delete(path);
      else merged.set(path, headVersion);
    }
    return merged;
  }

  /** Perform a pull request merge; the squash lands on the base branch. */
  mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): { sha: string } | null {
    const { headSha, baseSha } = this.pullTips(repo, pull);
    const merged = this.planMerge(repo, baseSha, headSha);
    if (merged === null) return null;
    const tree = this.storeFlatTree(repo, merged);
    let parents: string[];
    let message: string;
    if (method === 'merge') {
      parents = [baseSha, headSha];
      message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    } else {
      parents = [baseSha];
      message = pull.body === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
    }
    const sha = repo.store.put('commit', buildCommitData(tree, parents, message, this.ident()));
    repo.refs.set(this.branchRef(pull.baseRef), sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Line-level diff between two commits' trees. */
  diffCommits(repo: Repo, fromCommit: string, toCommit: string): FileChange[] {
    const fromTree = this.commitTree(repo, fromCommit);
    const toTree = this.commitTree(repo, toCommit);
    if (fromTree === null || toTree === null) return [];
    const from = this.flattenTree(repo, fromTree);
    const to = this.flattenTree(repo, toTree);
    const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
    const changes: FileChange[] = [];
    for (const path of paths) {
      const fromOid = from.get(path);
      const toOid = to.get(path);
      if (fromOid === toOid) continue;
      const fromText = fromOid === undefined ? null : (repo.store.get(fromOid)?.data ?? null);
      const toText = toOid === undefined ? null : (repo.store.get(toOid)?.data ?? null);
      const stats = diffLines(fromText, toText);
      changes.push({
        filename: path,
        status: fromOid === undefined ? 'added' : toOid === undefined ? 'removed' : 'modified',
        additions: stats.additions,
        deletions: stats.deletions,
        changes: stats.additions + stats.deletions,
        sha: toOid ?? fromOid ?? '',
      });
    }
    return changes;
  }
}

const ZERO_FALLBACK = '0'.repeat(40);

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function textLines(data: Buffer | null): string[] {
  if (data === null || data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Additions/deletions between two file versions, by longest common subsequence. */
export function diffLines(from: Buffer | null, to: Buffer | null): { additions: number; deletions: number } {
  const a = textLines(from);
  const b = textLines(to);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const widths = b.length + 1;
  let previous = new Uint32Array(widths);
  let current = new Uint32Array(widths);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] as number) + 1 : Math.max(previous[j] as number, current[j - 1] as number);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  const lcs = previous[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

// ------------------------------------------------------------- REST shapes

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: null, default: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER}/${repo.name}`,
    owner: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label as Label)),
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const tips = forge.pullTips(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: tips.headSha, label: `${VIEWER}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: tips.baseSha, label: `${VIEWER}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}
