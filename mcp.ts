// SPDX-License-Identifier: MIT
// The MCP surface at /mcp. Modern-era handshake: clients open with
// server/discover, read the supported protocol versions, then drive the
// classic tools/list and tools/call methods. The tool table is a frozen
// literal so tools/list serialises byte-identically on every call.

import { issueJson, pullJson, repoJson, type Forge } from './core.ts';
import { jsonResult, tokenAccepted, type HttpCtx, type HttpResult } from './app.ts';

const SERVER_NAME = 'sage-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open or closed.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolOk(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function callTool(forge: Forge, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return rpcError(null, -32602, `Unknown tool: ${name}`);
  }
  const args = (typeof params.arguments === 'object' && params.arguments !== null
    ? params.arguments
    : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (forge.getRepo('', repoName) !== undefined || forge.listRepos().some((r) => r.name === repoName)) {
        return toolError(`Repository ${repoName} already exists`);
      }
      const repo = forge.createRepo(
        repoName,
        str('description'),
        args.private === true,
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = forge.getRepo(str('owner'), str('repo'));
      if (repo === undefined) return toolError('Repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = forge.getRepo(str('owner'), str('repo'));
      if (repo === undefined) return toolError('Repository not found');
      const issue = forge.createIssue(repo, str('title'), str('body'), []);
      return toolOk(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = forge.getRepo(str('owner'), str('repo'));
      if (repo === undefined) return toolError('Repository not found');
      const state = str('state');
      const list = [...repo.issues.values()]
        .filter((issue) => state === '' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(str('owner'), str('repo'));
      if (repo === undefined) return toolError('Repository not found');
      const head = str('head');
      const base = str('base') === '' ? repo.defaultBranch : str('base');
      if (forge.branchTip(repo, head) === null) return toolError(`Head branch ${head} not found`);
      if (forge.branchTip(repo, base) === null) return toolError(`Base branch ${base} not found`);
      const pull = forge.createPull(repo, str('title'), str('body'), head, base);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(str('owner'), str('repo'));
      if (repo === undefined) return toolError('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state !== 'open') return toolError('Pull request is not open and cannot be merged');
      if (!forge.pullMergeable(repo, pull)) {
        return toolError('Pull request is not mergeable: merge conflict with the base branch');
      }
      forge.mergePull(repo, pull, 'merge');
      return toolOk(pullJson(forge, repo, pull));
    }
    default:
      return rpcError(null, -32602, `Unknown tool: ${name}`);
  }
}

function handleMessage(forge: Forge, message: JsonRpcRequest): Record<string, unknown> | null {
  const hasId = message.id !== undefined && message.id !== null;
  const id = hasId ? message.id : null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null
    ? message.params
    : {}) as Record<string, unknown>;
  if (!hasId) return null; // notification: acknowledged with an empty 202 upstream
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const result = callTool(forge, params);
      if ('error' in result && (result as { jsonrpc?: string }).jsonrpc === '2.0') {
        return { jsonrpc: '2.0', id, error: (result as { error: unknown }).error };
      }
      return rpcResult(id, result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(ctx: HttpCtx): HttpResult {
  if (ctx.method !== 'POST') {
    return jsonResult(404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } });
  }
  if (!tokenAccepted(ctx)) {
    return jsonResult(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonResult(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const response = handleMessage(ctx.forge, (entry ?? {}) as JsonRpcRequest);
      if (response !== null) responses.push(response);
    }
    return jsonResult(200, responses);
  }
  const response = handleMessage(ctx.forge, (parsed ?? {}) as JsonRpcRequest);
  if (response === null) {
    return { status: 202, body: Buffer.alloc(0), headers: {} };
  }
  return jsonResult(200, response);
}
