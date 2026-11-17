// SPDX-License-Identifier: MIT
// The GraphQL v4 surface at /api/graphql: a small parser for the document
// shapes gh and github-mcp-server send, a schema map for validation and
// introspection, and an executor over the same store as REST. Relay global
// ids are opaque base64 and stable across reads.

import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './core.ts';
import { errorResult, jsonResult, tokenAccepted, type HttpCtx, type HttpResult } from './app.ts';

// ---------------------------------------------------------------------------
// Lexer and parser
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const text = source.slice(index + 3, end < 0 ? source.length : end);
        tokens.push({ kind: 'string', value: text });
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let text = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const esc = source[index + 1] as string;
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else text += esc;
          index += 2;
        } else {
          text += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value: text });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'number', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = index;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`GraphQL syntax: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  opType: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface GqlDocument {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`GraphQL syntax: expected ${value}, got ${token.value}`);
    }
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ opType: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`GraphQL syntax: unexpected ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          opType: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('GraphQL syntax: fragment without on');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`GraphQL syntax: unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.next();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.next();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.next().value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return { kind: 'number', value: Number(token.value) };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL syntax: unexpected value ${token.value}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next().value });
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.next().value;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args =
        this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      this.skipDirectives();
      const selection =
        this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    return selections;
  }
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema: field maps for validation/execution, and the introspection defs.
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    reopenIssue: 'ReopenIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: '' },
  User: { id: '', login: '', name: '', url: '' },
  Repository: {
    id: '', databaseId: '', name: '', nameWithOwner: '', description: '', isPrivate: '',
    owner: 'User', defaultBranchRef: 'Ref', viewerPermission: '', hasIssuesEnabled: '',
    issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection', createdAt: '', updatedAt: '', url: '',
  },
  Issue: {
    id: '', databaseId: '', number: '', title: '', state: '', body: '', author: 'User',
    comments: 'CommentConnection', labels: 'LabelConnection', repository: 'Repository',
    createdAt: '', updatedAt: '', closedAt: '', url: '',
  },
  PullRequest: {
    id: '', databaseId: '', number: '', title: '', state: '', body: '', merged: '',
    mergeable: '', headRefName: '', baseRefName: '', author: 'User',
    files: 'PullRequestChangedFileConnection', mergeCommit: 'Commit', repository: 'Repository',
    createdAt: '', updatedAt: '', mergedAt: '', url: '',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: '' },
  IssueEdge: { node: 'Issue', cursor: '' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: '' },
  PullRequestEdge: { node: 'PullRequest', cursor: '' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo', totalCount: '' },
  PullRequestChangedFile: { path: '', additions: '', deletions: '', changeType: '' },
  CommentConnection: { nodes: 'Comment', pageInfo: 'PageInfo', totalCount: '' },
  Comment: { id: '', body: '', author: 'User', createdAt: '' },
  LabelConnection: { nodes: 'Label', totalCount: '' },
  Label: { name: '', color: '' },
  Ref: { name: '', prefix: '', target: 'Commit' },
  Commit: { oid: '', message: '', committedDate: '' },
  PageInfo: { hasNextPage: '', hasPreviousPage: '', startCursor: '', endCursor: '' },
  __Type: {
    name: '', kind: '', description: '', fields: '__Field', enumValues: '__EnumValue',
    possibleTypes: '__Type', inputFields: '__InputValue', specifiedByURL: '',
  },
  __Field: { name: '', description: '', type: '__Type', isDeprecated: '', deprecationReason: '' },
  __EnumValue: { name: '', description: '', isDeprecated: '', deprecationReason: '' },
  __InputValue: { name: '', type: '__Type' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: '' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: '' },
  ReopenIssuePayload: { issue: 'Issue', clientMutationId: '' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: '' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: '' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue', clientMutationId: '' },
  CommentEdge: { node: 'Comment', cursor: '' },
};

const TYPE_DEFS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'mergeCommit', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'url'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'url'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGid = (repo: Repo): string => globalId('Repository', String(repo.id));
const issueGid = (repo: Repo, issue: Issue): string => globalId('Issue', `${repo.id}:${issue.number}`);
const pullGid = (repo: Repo, pull: Pull): string => globalId('PullRequest', `${repo.id}:${pull.number}`);

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface GNode {
  type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  commentBody?: string;
  commentId?: number;
  nodes?: GNode[];
  hasNext?: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
  total?: number;
  name?: string;
  oid?: string;
  payload?: Record<string, GNode | string | null>;
  cursorKey?: number;
}

interface ExecCtx {
  forge: Forge;
  vars: Record<string, unknown>;
  doc: GqlDocument;
}

const userNode = (): GNode => ({ type: 'User' });
const repoNode = (repo: Repo): GNode => ({ type: 'Repository', repo });
const issueNode = (repo: Repo, issue: Issue): GNode => ({ type: 'Issue', repo, issue, cursorKey: issue.number });
const pullNode = (repo: Repo, pull: Pull): GNode => ({ type: 'PullRequest', repo, pull, cursorKey: pull.number });

function cursorOf(node: GNode): string {
  return Buffer.from(`cur:${node.cursorKey ?? 0}`, 'utf8').toString('base64');
}

function paginateNodes(nodes: GNode[], args: Record<string, unknown>, connType: string): GNode {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const key = Number.parseInt(decoded.replace('cur:', ''), 10);
      const at = nodes.findIndex((node) => node.cursorKey === key);
      if (at >= 0) start = at + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 30;
  const slice = nodes.slice(start, start + first);
  return {
    type: connType,
    nodes: slice,
    hasNext: start + first < nodes.length,
    startCursor: slice.length > 0 ? cursorOf(slice[0] as GNode) : null,
    endCursor: slice.length > 0 ? cursorOf(slice[slice.length - 1] as GNode) : null,
    total: nodes.length,
  };
}

type FieldValue = GNode | GNode[] | string | number | boolean | null;

function resolveField(node: GNode, field: string, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const forge = ctx.forge;
  switch (node.type) {
    case 'Query': {
      if (field === 'viewer') return userNode();
      if (field === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoNode(repo);
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = forge.listRepos().find((candidate) => candidate.id === Number(decoded.key));
          return repo === undefined ? null : repoNode(repo);
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':').map((part) => Number(part));
          const repo = forge.listRepos().find((candidate) => candidate.id === repoId);
          if (repo === undefined) return null;
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.get(number as number);
            return issue === undefined ? null : issueNode(repo, issue);
          }
          const pull = repo.pulls.get(number as number);
          return pull === undefined ? null : pullNode(repo, pull);
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        return TYPE_DEFS[name] === undefined ? null : { type: '__Type', name };
      }
      if (field === '__schema') return { type: '__Schema' };
      return null;
    }
    case 'Mutation':
      return resolveMutation(node, field, args, ctx);
    case 'User': {
      if (field === 'login') return VIEWER;
      if (field === 'id') return globalId('User', VIEWER);
      if (field === 'name') return VIEWER;
      if (field === 'url') return '';
      return null;
    }
    case 'Repository': {
      const repo = node.repo as Repo;
      switch (field) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${VIEWER}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return userNode();
        case 'defaultBranchRef': {
          const tip = forge.branchTip(repo, repo.defaultBranch);
          return tip === null ? null : { type: 'Ref', name: repo.defaultBranch, oid: tip };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const states = (args.states as unknown[]).map((state) => String(state));
            list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
          }
          const orderBy = args.orderBy as { direction?: string } | undefined;
          const desc = orderBy?.direction === 'DESC';
          list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
          return paginateNodes(list.map((issue) => issueNode(repo, issue)), args, 'IssueConnection');
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          if (Array.isArray(args.states)) {
            const states = (args.states as unknown[]).map((state) => String(state));
            list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          list.sort((a, b) => a.number - b.number);
          return paginateNodes(list.map((pull) => pullNode(repo, pull)), args, 'PullRequestConnection');
        }
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'url': return '';
        default: return null;
      }
    }
    case 'Issue': {
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      switch (field) {
        case 'id': return issueGid(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'author': return userNode();
        case 'repository': return repoNode(repo);
        case 'comments': {
          const nodes = issue.comments.map((comment) => ({
            type: 'Comment',
            repo,
            issue,
            commentBody: comment.body,
            commentId: comment.id,
            cursorKey: comment.id,
          }));
          return paginateNodes(nodes, args, 'CommentConnection');
        }
        case 'labels': {
          const nodes = issue.labels.map((name) => ({ type: 'Label', name }));
          return { type: 'LabelConnection', nodes, total: nodes.length };
        }
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'closedAt': return issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null;
        case 'url': return '';
        default: return null;
      }
    }
    case 'PullRequest': {
      const repo = node.repo as Repo;
      const pull = node.pull as Pull;
      switch (field) {
        case 'id': return pullGid(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': {
          if (pull.merged) return 'UNKNOWN';
          return forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return userNode();
        case 'repository': return repoNode(repo);
        case 'files': {
          const nodes = forge.pullFiles(repo, pull).map((file) => ({
            type: 'PullRequestChangedFile',
            name: file.filename,
            oid: file.sha,
            cursorKey: 0,
            payload: { additions: String(file.additions), deletions: String(file.deletions) },
          }));
          return paginateNodes(nodes, args, 'PullRequestChangedFileConnection');
        }
        case 'mergeCommit': {
          return pull.mergeCommitSha === null ? null : { type: 'Commit', oid: pull.mergeCommitSha };
        }
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'mergedAt': return pull.mergedAt;
        case 'url': return '';
        default: return null;
      }
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return node.name ?? '';
      if (field === 'additions') return Number(node.payload?.additions ?? 0);
      if (field === 'deletions') return Number(node.payload?.deletions ?? 0);
      if (field === 'changeType') return 'ADDED';
      return null;
    }
    case 'Comment': {
      if (field === 'id') {
        return globalId('Comment', `${node.repo?.id ?? 0}:${node.issue?.number ?? 0}:${node.commentId ?? 0}`);
      }
      if (field === 'body') return node.commentBody ?? '';
      if (field === 'author') return userNode();
      if (field === 'createdAt') return '2026-01-01T00:00:00Z';
      return null;
    }
    case 'Label': {
      if (field === 'name') return node.name ?? '';
      if (field === 'color') return 'ededed';
      return null;
    }
    case 'Ref': {
      if (field === 'name') return node.name ?? '';
      if (field === 'prefix') return `refs/heads/${node.name ?? ''}`;
      if (field === 'target') return { type: 'Commit', oid: node.oid ?? '' };
      return null;
    }
    case 'Commit': {
      if (field === 'oid') return node.oid ?? '';
      if (field === 'message') return '';
      if (field === 'committedDate') return '2026-01-01T00:00:00Z';
      return null;
    }
    case '__Type': {
      const def = TYPE_DEFS[node.name ?? ''];
      if (def === undefined) return null;
      if (field === 'name') return node.name ?? '';
      if (field === 'kind') return def.kind;
      if (field === 'description') return null;
      if (field === 'fields') {
        return (def.fields ?? []).map((fieldName) => ({ type: '__Field', name: fieldName }));
      }
      if (field === 'enumValues') {
        return (def.enumValues ?? []).map((valueName) => ({ type: '__EnumValue', name: valueName }));
      }
      if (field === 'possibleTypes') return [];
      if (field === 'inputFields') return [];
      if (field === 'specifiedByURL') return null;
      return null;
    }
    case '__Field': {
      if (field === 'name') return node.name ?? '';
      if (field === 'description') return null;
      if (field === 'type') return { type: '__Type', name: 'String' };
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return null;
    }
    case '__EnumValue': {
      if (field === 'name') return node.name ?? '';
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return null;
    }
    case '__Schema': {
      if (field === 'types') return Object.keys(TYPE_DEFS).map((name) => ({ type: '__Type', name }));
      if (field === 'queryType') return { type: '__Type', name: 'Query' };
      if (field === 'mutationType') return { type: '__Type', name: 'Mutation' };
      return null;
    }
    default: {
      // Connections and payloads resolve structurally.
      if (node.type.endsWith('Connection')) {
        if (field === 'nodes') return node.nodes ?? [];
        if (field === 'totalCount') return node.total ?? (node.nodes?.length ?? 0);
        if (field === 'pageInfo') {
          return {
            type: 'PageInfo',
            hasNext: node.hasNext ?? false,
            startCursor: node.startCursor ?? null,
            endCursor: node.endCursor ?? null,
          };
        }
        if (field === 'edges') {
          return (node.nodes ?? []).map((child) => ({
            type: node.type.replace('Connection', 'Edge'),
            nodes: [child],
            name: cursorOf(child),
          }));
        }
        return null;
      }
      if (node.type === 'PageInfo') {
        if (field === 'hasNextPage') return node.hasNext ?? false;
        if (field === 'hasPreviousPage') return false;
        if (field === 'startCursor') return node.startCursor ?? null;
        if (field === 'endCursor') return node.endCursor ?? null;
        return null;
      }
      if (node.type.endsWith('Edge')) {
        if (field === 'node') return (node.nodes ?? [])[0] ?? null;
        if (field === 'cursor') return node.name ?? '';
        return null;
      }
      if (node.payload !== undefined) {
        const value = node.payload[field];
        return value === undefined ? null : (value as FieldValue);
      }
      return null;
    }
  }
}

function resolveMutation(_node: GNode, field: string, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const findRepo = (id: unknown): Repo | undefined => {
    const decoded = decodeGlobalId(String(id ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') return undefined;
    return forge.listRepos().find((candidate) => candidate.id === Number(decoded.key));
  };
  const findIssue = (id: unknown): { repo: Repo; issue: Issue } | null => {
    const decoded = decodeGlobalId(String(id ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const [repoId, number] = decoded.key.split(':').map((part) => Number(part));
    const repo = forge.listRepos().find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    const issue = repo.issues.get(number as number);
    return issue === undefined ? null : { repo, issue };
  };
  const findPull = (id: unknown): { repo: Repo; pull: Pull } | null => {
    const decoded = decodeGlobalId(String(id ?? ''));
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const [repoId, number] = decoded.key.split(':').map((part) => Number(part));
    const repo = forge.listRepos().find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    const pull = repo.pulls.get(number as number);
    return pull === undefined ? null : { repo, pull };
  };
  switch (field) {
    case 'createIssue': {
      const repo = findRepo(input.repositoryId);
      if (repo === undefined) return null;
      const issue = forge.createIssue(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      return { type: 'CreateIssuePayload', payload: { issue: issueNode(repo, issue) } };
    }
    case 'closeIssue': {
      const found = findIssue(input.issueId);
      if (found === null) return null;
      found.issue.state = 'closed';
      return { type: 'CloseIssuePayload', payload: { issue: issueNode(found.repo, found.issue) } };
    }
    case 'reopenIssue': {
      const found = findIssue(input.issueId);
      if (found === null) return null;
      found.issue.state = 'open';
      return { type: 'ReopenIssuePayload', payload: { issue: issueNode(found.repo, found.issue) } };
    }
    case 'createPullRequest': {
      const repo = findRepo(input.repositoryId);
      if (repo === undefined) return null;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (forge.branchTip(repo, head) === null || forge.branchTip(repo, base) === null) return null;
      const pull = forge.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        head,
        base,
      );
      return { type: 'CreatePullRequestPayload', payload: { pullRequest: pullNode(repo, pull) } };
    }
    case 'mergePullRequest': {
      const found = findPull(input.pullRequestId);
      if (found === null) return null;
      const methodRaw = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
      const method = methodRaw === 'MERGE' ? 'merge' : methodRaw === 'REBASE' ? 'rebase' : 'squash';
      forge.mergePull(found.repo, found.pull, method);
      return { type: 'MergePullRequestPayload', payload: { pullRequest: pullNode(found.repo, found.pull) } };
    }
    case 'addComment': {
      const found = findIssue(input.subjectId);
      if (found === null) return null;
      const comment = { id: found.repo.nextCommentId, body: String(input.body ?? '') };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      const commentNode: GNode = {
        type: 'Comment',
        repo: found.repo,
        issue: found.issue,
        commentBody: comment.body,
        commentId: comment.id,
        cursorKey: comment.id,
      };
      return {
        type: 'AddCommentPayload',
        payload: {
          commentEdge: { type: 'CommentEdge', nodes: [commentNode], name: cursorOf(commentNode) },
          subject: issueNode(found.repo, found.issue),
        },
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Validation and the selection executor
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
}

function validateSelection(
  typeName: string,
  selections: SelectionNode[],
  doc: GqlDocument,
  errors: GqlError[],
): void {
  const fields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      validateSelection(selection.typeCondition, selection.selection, doc, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined) validateSelection(fragment.typeCondition, fragment.selection, doc, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    if (fields === undefined || !(selection.name in fields)) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    if (selection.selection !== null) {
      const childType = fields[selection.name] as string;
      if (childType !== '') validateSelection(childType, selection.selection, doc, errors);
    }
  }
}

function executeSelection(
  typeName: string,
  node: GNode,
  selections: SelectionNode[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      Object.assign(out, executeSelection(selection.typeCondition, node, selection.selection, ctx));
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelection(fragment.typeCondition, node, fragment.selection, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = evalValue(arg.value, ctx.vars);
    const value = resolveField(node, selection.name, args, ctx);
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: FieldValue, selection: FieldNode, ctx: ExecCtx): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (typeof value === 'object') {
    if (selection.selection === null) return null;
    return executeSelection(value.type, value, selection.selection, ctx);
  }
  return value;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: GqlError[];
}

function executeOperation(forge: Forge, body: Record<string, unknown>): OperationResult {
  const query = typeof body.query === 'string' ? body.query : '';
  const vars = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let doc: GqlDocument;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    doc.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const errors: GqlError[] = [];
  validateSelection(rootType, operation.selection, doc, errors);
  if (errors.length > 0) return { data: null, errors };
  const ctx: ExecCtx = { forge, vars, doc };
  const root: GNode = { type: rootType };
  return { data: executeSelection(rootType, root, operation.selection, ctx) };
}

export function handleGraphql(ctx: HttpCtx): HttpResult {
  if (ctx.method !== 'POST') return errorResult(404, 'Not Found');
  if (!tokenAccepted(ctx)) return jsonResult(401, { message: 'Unauthorized' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonResult(400, { errors: [{ message: 'Malformed JSON body' }] });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      executeOperation(ctx.forge, (entry ?? {}) as Record<string, unknown>),
    );
    return jsonResult(200, results);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return jsonResult(400, { errors: [{ message: 'GraphQL body must be an object or an array' }] });
  }
  return jsonResult(200, executeOperation(ctx.forge, parsed as Record<string, unknown>));
}
