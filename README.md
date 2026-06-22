# hugo-aiv-logs

Independent Bun/TypeScript tooling for querying Hugo AIV diagnostic logs from Alibaba Cloud SLS, normalizing noisy remote reports, deduplicating repeated events, and producing a compact analysis package.

## Setup

```bash
bun install
cp .env.example .env
cp .env.local.example .env.local
```

Use two config files:

- `.env`: sensitive or runtime values, such as cookie, CSRF, cache, and LLM keys.
- `.env.local`: non-sensitive SLS targets, such as account mode, project, logstore, and region.

Current account mode is `single`, meaning alpha and production use the same console
account/cookie while each environment keeps its own project/logstore target.

```bash
SLS_ENVIRONMENTS=alpha,production

SLS_CONSOLE_ALPHA_BASE_URL=https://sls.console.aliyun.com
SLS_CONSOLE_ALPHA_COOKIE=...
SLS_CONSOLE_ALPHA_CSRF_TOKEN=...
SLS_CONSOLE_ALPHA_REFERER=...

SLS_CONSOLE_PRODUCTION_BASE_URL=https://sls.console.aliyun.com
SLS_CONSOLE_PRODUCTION_COOKIE=...
SLS_CONSOLE_PRODUCTION_CSRF_TOKEN=...
SLS_CONSOLE_PRODUCTION_REFERER=...
```

`.env.local` should contain:

```bash
SLS_ACCOUNT_MODE=single

SLS_ALPHA_PROJECT_NAME=k8s-log-cb1a1487044024414acfac80f0d375bc9
SLS_ALPHA_LOGSTORE_NAME=hugo-alpha-api
SLS_ALPHA_REGION=cn-shenzhen

SLS_PRODUCTION_PROJECT_NAME=k8s-log-c7c49b76851914521a874b49399a75ca1
SLS_PRODUCTION_LOGSTORE_NAME=hugo-api
SLS_PRODUCTION_REGION=cn-shenzhen
```

Account modes:

- `single`: one console cookie shared by alpha and production. Cookie cache is stored as `.cache/console-auth/single.json`.
- `environment`: alpha and production use separate console cookies. Cookie cache is stored as `.cache/console-auth/<env>.json`.

Analysis is local and Codex-oriented. The tool does not call an LLM API; it writes
`summary.md` plus `conclusion.md`, and Codex can then read `logs.json` and
`summary.md` to refine the conclusion with deeper code reasoning.

## Commands

Query and analyze with Aliyun console API cookies:

```bash
bun run query -- --env production --from "2h ago" --to now
```

Fetch more pages:

```bash
bun run query -- --from "2h ago" --to now --line 100 --max-pages 50
```

Query multiple environments:

```bash
bun run query -- --env alpha,production --from "2026-05-28 00:00:00+08:00" --to now
```

## Agent Skill

Agents should use the bundled skill instead of MCP:

```txt
skills/sls-cli/
```

The skill guides agents to query SLS through the same Bun scripts documented here:
`cookie:auto`, `cookie:status`, `cookie:import`, `query`, `analyze`, and
`classify:skeleton`.

## Time Arguments

`--from` and `--to` support:

- `now`
- `2h ago`, `30m ago`, `1d ago`
- Unix seconds or milliseconds
- ISO timestamps
- `YYYY-MM-DD HH:mm:ss+08:00`

## Outputs

Each query writes to a readable artifact directory:

```txt
artifacts/<local-run-time>/
```

Example:

```txt
artifacts/2026-05-29_13:05:42/
```

The query window, environments, query text, provider, and counts are summarized in
`summary.md`.

The directory contains:

- `logs.json` readable, parsed logs with diagnostics payload chunks reassembled by trace id
- `summary.md` query summary generated after analysis
- `conclusion.md` Codex-oriented statistics, classification, evidence, and code context hints based on `logs.json` + `summary.md`

Temporary query/analysis files are not kept in the artifact directory.

## Query

The default query targets current app remote diagnostic groups:

- `[MotionVideoSkeletonStuck]`
- `[videoPlayerError]`
- `[motionVideoDl]`
- `[LinkVideoDraftTrace]`
- `[FetchNetworkError]`

Override it when needed:

```bash
bun run query -- --query "'[motionVideoDl]' and ResponseInterceptor not native_generating"
```

For targeted diagnostic-label queries, include `and ResponseInterceptor` unless you are intentionally comparing raw emitters. Most diagnostic events are emitted by both `ApplicationController` and `ResponseInterceptor`; filtering to `ResponseInterceptor` avoids roughly 2x duplicated/noisy counts.

## Console API Query

The only supported SLS access path is the same console request family used by the
browser. SDK, STS, and API Explorer proxy code is kept under `src/sdk-backup/` for
reference, but normal querying should use console cookies.

### Auto Import From Dia

Start Dia with Chromium remote debugging enabled, then run:

```bash
bun run cookie:auto
```

The command connects to `http://127.0.0.1:9222`, reuses an existing SLS profile
tab or opens `https://sls.console.aliyun.com/lognext/profile`, and captures the
`getConfigData.json` request. It imports the Cookie and `x-csrf-token` into the
shared `single` auth cache, then probes both alpha and production.

The command does not start or close Dia. Its optional overrides are:

```bash
bun run cookie:auto -- --cdp http://127.0.0.1:9333 --timeout 30
```

### Import Cookie From Browser cURL

1. Open Alibaba Cloud SLS console and run the target search once.
2. Open browser DevTools Network.
3. Filter for one of these requests:
   - `getLogs.json`
   - `getHistograms.json`
4. Copy the request as cURL.
5. Save it to `.cookie.<env>` and import it for the matching environment:

```bash
pbpaste > .cookie.production
bun run cookie:import -- --env production

pbpaste > .cookie.alpha
bun run cookie:import -- --env alpha
```

`cookie:import --env production` reads `.cookie.production` by default, and
`cookie:import --env alpha` reads `.cookie.alpha`. For one-off imports, you can
still pass `--curl-file <path>`.

Only one cURL is needed per environment. It can be any SLS console request that contains:

- `-b` / `--cookie` or a `cookie:` header
- `x-csrf-token`
- `ProjectName` and `LogStoreName` in `--data-raw`
- usually a `referer` containing `slsRegion=<region>`

The importer extracts cookie, CSRF token, referer, user-agent, project, and logstore.
`ProjectName` / `LogStoreName` are treated as non-sensitive target config:

- If `.env.local` has no value for that env, the importer writes values from the cURL.
- If `.env.local` already has the same values, the importer leaves it unchanged.
- If `.env.local` has different values, the importer fails so you can confirm whether the cURL is alpha or production.

For example alpha currently uses:

```txt
ProjectName=k8s-log-cb1a1487044024414acfac80f0d375bc9
LogStoreName=hugo-alpha-api
```

The parsed auth is cached here:

```txt
.cache/console-auth/<env>.json
```

In `single` account mode, the shared cookie is cached at:

```txt
.cache/console-auth/single.json
```

Check or probe the cache:

```bash
bun run cookie:status -- --env alpha,production
bun run cookie:status -- --env production
bun run cookie:status -- --env production --probe false
```

`cookie:status` probes the console API by default. Use `--probe false` only when
you want to inspect cached fields without checking whether the cookie is usable.
If probe returns `ConsoleNeedLogin` / `needLogin`, copy a fresh cURL from the
browser and import it again.

You can also put sensitive cookie values directly in `.env` if preferred:

```bash
SLS_CONSOLE_PRODUCTION_COOKIE='aliyun_enable_passkey=...; isg=...'
SLS_CONSOLE_PRODUCTION_CSRF_TOKEN=a2a08ebf
SLS_CONSOLE_PRODUCTION_REFERER='https://sls.console.aliyun.com/lognext/project/<project>/logsearch/<logstore>?slsRegion=<region>'
```

### Query With Cached Cookie

After importing the cookie, query logs with `query`:

```bash
bun run query -- --env production --from "1h ago" --to now --query "'[MotionVideoSkeletonStuck]' and ResponseInterceptor"
```

Pagination is controlled by `--line` and `--max-pages`:

```bash
bun run query -- --env alpha --from "1h ago" --to now --line 100 --max-pages 20
```

`query` automatically writes `summary.md` after fetching and clustering logs. The query responses are cached by query window, env, project, logstore, query, and paging
options. To force a live request:

```bash
QUERY_CACHE_PROVIDER=none bun run query -- --env alpha --from "1h ago" --to now
bun run query -- --env production --from "1h ago" --to now --cache false
```

The query path intentionally does not store cookies in run artifacts. It calls the same request family observed from the console:

- `/console/logstoreindex/getLogs.json`
- `/console/logstoreindex/getHistograms.json`
- `/console/logs/getLogs.json`

`/console/logs/getLogs.json` is used as the primary log source. The first two responses are saved to `console-meta-by-env.json` for debugging response shape and count issues. By default the primary query appends `| with_pack_meta`; disable that with:

```bash
bun run query -- --with-pack-meta false
```

## Query Response Cache

SLS responses are cached before normalization/analysis. Default cache is local file cache:

```bash
QUERY_CACHE_PROVIDER=file
QUERY_CACHE_TTL_SECONDS=3600
```

Disable cache:

```bash
QUERY_CACHE_PROVIDER=none bun run query -- --env production --from "2h ago" --to now
```

Use Valkey with Docker:

```bash
docker compose -f docker-compose.valkey.yml up -d
```

Then set:

```bash
QUERY_CACHE_PROVIDER=auto
VALKEY_URL=redis://127.0.0.1:6379/0
```

`auto` tries Valkey first and falls back to file cache. Use `QUERY_CACHE_PROVIDER=valkey` if you want failures to surface instead of falling back.
