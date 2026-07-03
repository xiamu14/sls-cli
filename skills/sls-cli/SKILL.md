---
name: sls-cli
description: Query and analyze Alibaba Cloud SLS diagnostic logs through the sls-cli Bun scripts, not through MCP. Use when Codex needs to inspect production or alpha SLS logs from any workspace, locate or switch to the sls-cli repository, refresh/import console cookies, check cookie health, generate timestamped artifacts, classify motion skeleton issues, or summarize log evidence from logs.json, summary.md, and conclusion.md.
---

# SLS CLI

## Overview

Use this skill to operate the SLS tooling through the `sls-cli` repository's `bun run` scripts. The normal flow is: locate the `sls-cli` repository, check cookie health, import a fresh console cURL if needed, query logs, then read the generated artifact files for reasoning.

Do not start or call an MCP server for this workflow.

## Repository Location

Always run SLS commands from the `sls-cli` repository, not from the user's current app workspace unless it is already `sls-cli`.

1. If the current workspace has `package.json` scripts named `cookie:status`, `cookie:import`, and `query`, use that workspace root.
2. Otherwise use the known local repository:

```bash
cd /Users/ben/Workspace/Project/sls-cli
```

3. If that path is unavailable, search nearby project roots for a `package.json` with those scripts before telling the user the SLS CLI cannot be found.

## Quick Start

Run commands from the `sls-cli` repository root.

```bash
bun run cookie:status -- --env production
bun run query -- --env production --from "2h ago" --to now
```

Query both configured environments when comparing alpha and production behavior:

```bash
bun run query -- --env alpha,production --from "2h ago" --to now
```

After a successful query, inspect the newest `artifacts/<local-run-time>/` directory. Use `logs.json` as the primary evidence source, with `summary.md` and `conclusion.md` as indexes and first-pass analysis.

## Workflow

1. Check cached console auth before querying:

```bash
bun run cookie:status -- --env alpha,production
```

Use `--probe false` only when a live console probe is unnecessary:

```bash
bun run cookie:status -- --env production --probe false
```

2. If status reports `ConsoleNeedLogin`, `needLogin`, or another auth failure,
prefer automatic import from the configured browser:

```bash
bun run cookie:auto
```

This starts or restarts the configured browser (`SLS_COOKIE_BROWSER=dia` by
default, `chrome` supported), opens or refreshes the SLS profile page, captures
a profile request with CSRF, imports the shared cookie in `single` account mode,
and probes both alpha and production.

If browser CDP is unavailable, ask the user for a fresh Alibaba Cloud SLS console
cURL or import one already saved on disk. The expected files are
`.cookie.production` and `.cookie.alpha`.

```bash
bun run cookie:import -- --env production
bun run cookie:import -- --env alpha
```

For one-off imports:

```bash
bun run cookie:import -- --env production --curl-file path/to/curl.txt
```

3. Query the requested window. The default query covers the current app remote diagnostic groups. Override `--query` for targeted investigations.

For any targeted diagnostic-label query, always include `and ResponseInterceptor` unless the user explicitly says not to. Do this even when the user only names the label. The same diagnostic event is commonly logged once by `ApplicationController` and once by `ResponseInterceptor`; omitting `ResponseInterceptor` makes counts and samples roughly 2x duplicated/noisy. This filter is also required for `LinkVideoDraftTrace` investigations.

```bash
bun run query -- --env production --from "1h ago" --to now
bun run query -- --env production --from "7d ago" --to now --query "'[LinkVideoDraftTrace]' and ResponseInterceptor"
bun run query -- --env production --from "1h ago" --to now --query "'[MotionVideoSkeletonStuck]' and ResponseInterceptor"
```

Use pagination flags for broader pulls:

```bash
bun run query -- --env alpha --from "1h ago" --to now --line 100 --max-pages 50
```

Disable cache when freshness matters:

```bash
bun run query -- --env production --from "1h ago" --to now --cache false
QUERY_CACHE_PROVIDER=none bun run query -- --env alpha --from "1h ago" --to now
```

4. Read artifacts. A query that finds logs writes:

```txt
artifacts/<local-run-time>/
```

Important files:

- `logs.json`: readable parsed logs with diagnostics payload chunks reassembled by trace id.
- `summary.md`: query window, environments, query text, provider, counts, and cluster index.
- `conclusion.md`: local statistics, classification, evidence, and code-context hints.

5. For motion skeleton investigations, run the classifier on an artifact directory when useful:

```bash
bun run classify:skeleton -- --artifact artifacts/<local-run-time>
```

## Time Arguments

`--from` and `--to` accept:

- `now`
- `2h ago`, `30m ago`, `1d ago`
- Unix seconds or milliseconds
- ISO timestamps
- `YYYY-MM-DD HH:mm:ss+08:00`

## Reasoning Guidance

Prefer `logs.json` for bug reasoning and evidence. Treat `summary.md` as a navigational index and `conclusion.md` as a first-pass local analysis, not as the final answer.

When reporting findings, include the query command, artifact directory, time window, environment, and the log patterns or trace ids that support the conclusion.
