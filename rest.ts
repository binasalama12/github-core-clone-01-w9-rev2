// SPDX-License-Identifier: MIT
// The REST v3 surface under /api/v3: repositories, branches, commits, the
// contents API, labels, issues, comments and pull requests. Every reply is
// JSON with a request id; errors are JSON with a message.

import {
  VIEWER,
  VIEWER_ID,
  commentJson,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  type Forge,
  type Repo,
} from './core.ts';
import { errorResult, jsonResult, tokenAccepted, type HttpCtx, type HttpResult } from './app.ts';

let requestSeq = 0;

export function handleRest(ctx: HttpCtx): HttpResult {
  const result = dispatch(ctx);
  requestSeq += 1;
  return {
    ...result,
    headers: { ...(result.headers ?? {}), 'x-github-request-id': `sage-${requestSeq.toString(36)}` },
  };
}

interface Body {
  value: Record<string, unknown> | null;
  error: HttpResult | null;
}

function parseBody(ctx: HttpCtx): Body {
  if (ctx.body.length === 0) return { value: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: errorResult(400, 'Request body must be a JSON object') };
    }
    return { value: parsed as Record<string, unknown>, error: null };
  } catch {
    return { value: null, error: errorResult(400, 'Malformed JSON in request body') };
  }
}

function dispatch(ctx: HttpCtx): HttpResult {
  if (!tokenAccepted(ctx)) return errorResult(401, 'Unauthorized');
  const forge = ctx.forge;
  const segments = ctx.path
    .slice('/api/v3'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));

  if (segments.length === 0) {
    if (ctx.method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(
      200,
      {
        current_user_url: `http://${ctx.host}/api/v3/user`,
        repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
        issue_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}/issues/{number}`,
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (ctx.method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, { installed_version: '3.10.0', node_version: '22' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (ctx.method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, { login: VIEWER, id: VIEWER_ID, type: 'User' });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (ctx.method === 'GET') return paginate(ctx, forge.listRepos(), (repo) => repoJson(repo));
    if (ctx.method === 'POST') return createRepo(ctx);
    return errorResult(404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = forge.getRepo(owner, name);
    if (segments.length === 3) {
      if (ctx.method === 'GET') {
        if (repo === undefined) return errorResult(404, 'Not Found');
        return jsonResult(200, repoJson(repo));
      }
      if (ctx.method === 'PATCH') {
        if (repo === undefined) return errorResult(404, 'Not Found');
        const body = parseBody(ctx);
        if (body.error !== null) return body.error;
        if (typeof body.value?.description === 'string') repo.description = body.value.description;
        return jsonResult(200, repoJson(repo));
      }
      if (ctx.method === 'DELETE') {
        if (repo === undefined) return errorResult(404, 'Not Found');
        forge.deleteRepo(owner, name);
        return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
      }
      return errorResult(404, 'Not Found');
    }
    if (repo === undefined) return errorResult(404, 'Not Found');
    return repoRoute(ctx, repo, segments.slice(3));
  }
  return errorResult(404, 'Not Found');
}

function createRepo(ctx: HttpCtx): HttpResult {
  const body = parseBody(ctx);
  if (body.error !== null) return body.error;
  const value = body.value as Record<string, unknown>;
  const name = value.name;
  if (typeof name !== 'string' || name === '') return errorResult(422, 'Repository name is required');
  const isPrivate = typeof value.private === 'boolean' ? value.private : false;
  const description = typeof value.description === 'string' ? value.description : '';
  const repo = ctx.forge.createRepo(name, isPrivate, description);
  if (repo === null) return errorResult(422, 'Repository already exists');
  return jsonResult(201, repoJson(repo));
}

function paginate<T>(ctx: HttpCtx, items: T[], serialize: (item: T) => unknown): HttpResult {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (items.length > 0 && (page < totalPages || page > 1)) {
    const linkFor = (target: number): string => {
      const params = new URLSearchParams(ctx.query);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `http://${ctx.host}${ctx.path}?${params.toString()}`;
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`<${linkFor(page + 1)}>; rel="next"`);
      links.push(`<${linkFor(totalPages)}>; rel="last"`);
    }
    if (page > 1) {
      links.push(`<${linkFor(1)}>; rel="first"`);
      links.push(`<${linkFor(page - 1)}>; rel="prev"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return jsonResult(200, slice.map(serialize), headers);
}

function repoRoute(ctx: HttpCtx, repo: Repo, rest: string[]): HttpResult {
  const forge = ctx.forge;
  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'contents') return contentsRoute(ctx, repo, tail);
  if (head === 'branches') {
    if (tail.length === 0 && ctx.method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string }, protected: false }));
      return jsonResult(200, branches);
    }
    if (tail.length >= 1 && ctx.method === 'GET') {
      const branch = tail.join('/');
      const sha = repo.refs.get(forge.branchRef(branch));
      if (sha === undefined) return errorResult(404, 'Not Found');
      return jsonResult(200, { name: branch, commit: { sha }, protected: false });
    }
    return errorResult(404, 'Not Found');
  }
  if (head === 'commits' && tail.length === 0 && ctx.method === 'GET') {
    const startRef = ctx.query.get('sha') ?? repo.defaultBranch;
    const start = forge.resolveCommit(repo, startRef);
    if (start === null) return jsonResult(200, []);
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      ordered.push(oid);
      const parsed = repo.store.commit(oid);
      if (parsed === null) continue;
      for (let index = parsed.parents.length - 1; index >= 0; index -= 1) {
        stack.push(parsed.parents[index] as string);
      }
    }
    const items = ordered.map((oid) => {
      const parsed = repo.store.commit(oid);
      return {
        sha: oid,
        commit: {
          message: parsed?.message ?? '',
          tree: { sha: parsed?.tree ?? '' },
          author: { name: VIEWER, email: `${VIEWER}@localhost`, date: '2026-01-01T00:00:00Z' },
          committer: { name: VIEWER, email: `${VIEWER}@localhost`, date: '2026-01-01T00:00:00Z' },
        },
        parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    return paginate(ctx, items, (item) => item);
  }
  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1 && ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body.error !== null) return body.error;
      const value = body.value as Record<string, unknown>;
      const ref = value.ref;
      const sha = value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) return errorResult(422, 'ref is required');
      if (typeof sha !== 'string' || repo.store.commit(sha) === null) {
        return errorResult(422, 'sha does not name a commit in this repository');
      }
      if (repo.refs.has(ref)) return errorResult(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonResult(201, { ref, object: { sha, type: 'commit' } });
    }
    if (tail.length >= 2 && ctx.method === 'GET') {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return errorResult(404, 'Not Found');
      const object = repo.store.get(oid);
      return jsonResult(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
    }
    return errorResult(404, 'Not Found');
  }
  if (head === 'labels') {
    if (tail.length === 0 && ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body.error !== null) return body.error;
      const value = body.value as Record<string, unknown>;
      if (typeof value.name !== 'string' || value.name === '') return errorResult(422, 'Label name is required');
      const color = typeof value.color === 'string' ? value.color : 'ededed';
      const label = forge.createLabel(repo, value.name, color);
      if (label === null) return errorResult(422, 'Label already exists');
      return jsonResult(201, labelJson(label));
    }
    if (tail.length === 0 && ctx.method === 'GET') {
      return jsonResult(200, [...repo.labels.values()].map((label) => labelJson(label)));
    }
    return errorResult(404, 'Not Found');
  }
  if (head === 'issues') return issuesRoute(ctx, repo, tail);
  if (head === 'pulls') return pullsRoute(ctx, repo, tail);
  return errorResult(404, 'Not Found');
}

function contentsRoute(ctx: HttpCtx, repo: Repo, parts: string[]): HttpResult {
  const forge = ctx.forge;
  if (ctx.method === 'PUT') {
    const body = parseBody(ctx);
    if (body.error !== null) return body.error;
    const value = body.value as Record<string, unknown>;
    if (parts.length === 0) return errorResult(422, 'A file path is required');
    const branchRaw = typeof value.branch === 'string' ? value.branch : repo.defaultBranch;
    const branch = branchRaw.startsWith('refs/heads/') ? branchRaw.slice('refs/heads/'.length) : branchRaw;
    const tip = forge.branchTip(repo, branch);
    const treeOid = tip === null ? null : forge.commitTree(repo, tip);
    const existing = treeOid === null ? null : forge.treeLookup(repo, treeOid, parts);
    if (existing !== null && existing.kind === 'tree') return errorResult(422, 'Path is a directory');
    if (value.sha !== undefined && (existing === null || existing.oid !== value.sha)) {
      return errorResult(409, 'The sha does not match the current file');
    }
    if (value.sha === undefined && existing !== null) {
      return errorResult(422, 'A sha is required to update an existing file');
    }
    const content = typeof value.content === 'string' ? value.content : '';
    const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const message = typeof value.message === 'string' ? value.message : '';
    const { commitOid, blobOid } = forge.commitFile(repo, branch, parts.join('/'), bytes, message);
    return jsonResult(existing !== null ? 200 : 201, {
      content: {
        name: parts[parts.length - 1] as string,
        path: parts.join('/'),
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitOid, message },
    });
  }
  if (ctx.method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const commitOid = forge.resolveCommit(repo, ref);
    if (commitOid === null) return errorResult(404, 'Not Found');
    const treeOid = forge.commitTree(repo, commitOid);
    if (treeOid === null) return errorResult(404, 'Not Found');
    if (parts.length === 0) return jsonResult(200, listTree(repo, treeOid, ''));
    const node = forge.treeLookup(repo, treeOid, parts);
    if (node === null) return errorResult(404, 'Not Found');
    if (node.kind === 'tree') return jsonResult(200, listTree(repo, node.oid, parts.join('/')));
    const blob = repo.store.get(node.oid);
    if (blob === undefined) return errorResult(404, 'Not Found');
    return jsonResult(200, {
      type: 'file',
      name: parts[parts.length - 1] as string,
      path: parts.join('/'),
      sha: node.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
  }
  if (ctx.method === 'DELETE') {
    const body = parseBody(ctx);
    if (body.error !== null) return body.error;
    const value = body.value as Record<string, unknown>;
    const tip = forge.branchTip(repo, repo.defaultBranch);
    const treeOid = tip === null ? null : forge.commitTree(repo, tip);
    const existing = treeOid === null ? null : forge.treeLookup(repo, treeOid, parts);
    if (existing === null || existing.kind !== 'blob') return errorResult(404, 'Not Found');
    if (typeof value.sha === 'string' && value.sha !== existing.oid) {
      return errorResult(409, 'The sha does not match the current file');
    }
    const message = typeof value.message === 'string' ? value.message : '';
    const { commitOid } = forge.commitFile(repo, repo.defaultBranch, parts.join('/'), null, message);
    return jsonResult(200, { content: null, commit: { sha: commitOid, message } });
  }
  return errorResult(404, 'Not Found');
}

function listTree(repo: Repo, treeOid: string, prefix: string): unknown[] {
  const entries = repo.store.tree(treeOid) ?? [];
  return entries.map((entry) => {
    const object = repo.store.get(entry.oid);
    return {
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (object?.data.length ?? 0),
    };
  });
}

function issuesRoute(ctx: HttpCtx, repo: Repo, tail: string[]): HttpResult {
  const forge = ctx.forge;
  if (tail.length === 0) {
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body.error !== null) return body.error;
      const value = body.value as Record<string, unknown>;
      if (typeof value.title !== 'string' || value.title === '') return errorResult(422, 'Issue title is required');
      const labelNames: string[] = [];
      if (Array.isArray(value.labels)) {
        for (const entry of value.labels) {
          const labelName = typeof entry === 'string' ? entry : null;
          if (labelName === null) return errorResult(422, 'Labels must be names');
          if (!repo.labels.has(labelName)) return errorResult(422, `Label '${labelName}' does not exist`);
          labelNames.push(labelName);
        }
      }
      const issue = forge.createIssue(repo, value.title, typeof value.body === 'string' ? value.body : '', labelNames);
      return jsonResult(201, issueJson(forge, repo, issue));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return paginate(ctx, issues, (issue) => issueJson(forge, repo, issue));
    }
    return errorResult(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (issue === undefined) return errorResult(404, 'Not Found');
    if (ctx.method === 'GET') return jsonResult(200, issueJson(forge, repo, issue));
    if (ctx.method === 'PATCH') {
      const body = parseBody(ctx);
      if (body.error !== null) return body.error;
      const value = body.value as Record<string, unknown>;
      if (value.state === 'open' || value.state === 'closed') issue.state = value.state;
      if (typeof value.title === 'string') issue.title = value.title;
      if (typeof value.body === 'string') issue.body = value.body;
      return jsonResult(200, issueJson(forge, repo, issue));
    }
    return errorResult(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return errorResult(404, 'Not Found');
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body.error !== null) return body.error;
      const value = body.value as Record<string, unknown>;
      if (typeof value.body !== 'string') return errorResult(422, 'Comment body is required');
      const comment = { id: repo.nextCommentId, body: value.body };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return jsonResult(201, commentJson(comment));
    }
    if (ctx.method === 'GET') return jsonResult(200, issue.comments.map((comment) => commentJson(comment)));
    return errorResult(404, 'Not Found');
  }
  return errorResult(404, 'Not Found');
}

function pullsRoute(ctx: HttpCtx, repo: Repo, tail: string[]): HttpResult {
  const forge = ctx.forge;
  if (tail.length === 0) {
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body.error !== null) return body.error;
      const value = body.value as Record<string, unknown>;
      const stripPrefix = (raw: unknown): string => {
        if (typeof raw !== 'string') return '';
        const colon = raw.lastIndexOf(':');
        return colon >= 0 ? raw.slice(colon + 1) : raw;
      };
      const head = stripPrefix(value.head);
      const base = value.base === undefined ? repo.defaultBranch : stripPrefix(value.base);
      if (typeof value.title !== 'string') return errorResult(422, 'Pull request title is required');
      if (head === '' || forge.branchTip(repo, head) === null) {
        return errorResult(422, 'Head branch does not exist');
      }
      if (base === '' || forge.branchTip(repo, base) === null) {
        return errorResult(422, 'Base branch does not exist');
      }
      if (forge.branchTip(repo, head) === forge.branchTip(repo, base)) {
        return errorResult(422, 'No commits between the base and head branches');
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return errorResult(422, 'A pull request already exists for this branch');
        }
      }
      const pull = forge.createPull(repo, value.title, typeof value.body === 'string' ? value.body : '', head, base);
      return jsonResult(201, pullJson(forge, repo, pull));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      return paginate(ctx, pulls, (pull) => pullJson(forge, repo, pull));
    }
    return errorResult(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1 && ctx.method === 'GET') {
    if (pull === undefined) return errorResult(404, 'Not Found');
    return jsonResult(200, pullJson(forge, repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'files' && ctx.method === 'GET') {
    if (pull === undefined) return errorResult(404, 'Not Found');
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    }));
    return paginate(ctx, files, (file) => file);
  }
  if (tail.length === 2 && tail[1] === 'merge' && ctx.method === 'PUT') {
    if (pull === undefined) return errorResult(404, 'Not Found');
    const body = parseBody(ctx);
    if (body.error !== null) return body.error;
    if (pull.state !== 'open') return errorResult(405, 'Pull Request is not mergeable');
    const methodRaw = (body.value as Record<string, unknown>).merge_method;
    const method = methodRaw === 'squash' || methodRaw === 'rebase' ? methodRaw : 'merge';
    const merged = forge.mergePull(repo, pull, method);
    if (merged === null) return errorResult(405, 'Pull Request is not mergeable');
    return jsonResult(200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return errorResult(404, 'Not Found');
}
