[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binasalama12/github-core-clone-01-w9-rev2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binasalama12/github-core-clone-01-w9-rev2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Sage Forge

A GitHub-compatible git forge written from scratch for the
[github-core-clone-01](https://make.fun/competitions/github-core-clone-01)
competition on make.fun. One dependency-free Node 22 process serves four
surfaces out of a single in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 (capability advertisement,
  ls-refs, shallow fetch with deepen) and receive-pack v0 (report-status,
  side-band-64k, delete-refs), with real packfiles: objects are stored
  byte-for-byte as pushed and re-packed on fetch with exact want/have
  negotiation, so an incremental fetch ships precisely the objects the
  client is missing.
- **REST v3** under `/api/v3` — repositories, branches, commits, the
  contents API, labels, issues, comments and pull requests with three-way
  squash merges and per-file diff stats.
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and
  github-mcp-server send, introspection included, Relay global ids and
  cursor pagination, plus operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP speaking revision
  2026-07-28 (`server/discover`) with the six repository tools acting on
  the same store as REST.

## Performance notes

The forge is built around the four timed workloads:

- pack object access inflates each zlib stream exactly once per entry
  (`inflateSync` with `info: true`, so the consumed byte count is exact);
- object ids are hashed once per object and parsed commits/trees are
  memoised per repository;
- fast-forward checks walk ancestors depth-first with early exit instead
  of materialising full histories;
- repeated fetches of the same tips are served from a per-repository pack
  cache, and the hot REST paths (issue read/write) do no avoidable
  allocation.

## Running

The entrypoint is `main.ts`. It binds an ephemeral port, registers with
the trial environment in `MAKEFUN_ENV_URL`, serves until the environment
reports the trial is done, and exits 0.

```
node main.ts
```

No dependencies, no build step: Node 22 runs the TypeScript sources
directly (erasable syntax only).

## License

MIT — see `LICENSE`.
