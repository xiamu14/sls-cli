# hugo-aiv-logs

Independent Bun/TypeScript tooling for pulling Hugo AIV diagnostic logs from Alibaba Cloud SLS, normalizing noisy remote reports, deduplicating repeated events, and producing a compact analysis package.

## Setup

```bash
bun install
cp .env.example .env
```

Fill `.env` with both environments:

```bash
SLS_ENVIRONMENTS=alpha,production

SLS_ALPHA_ENDPOINT=cn-hangzhou.log.aliyuncs.com
SLS_ALPHA_ACCESS_KEY_ID=...
SLS_ALPHA_ACCESS_KEY_SECRET=...
SLS_ALPHA_PROJECT_NAME=...
SLS_ALPHA_LOGSTORE_NAME=...

SLS_PRODUCTION_ENDPOINT=cn-hangzhou.log.aliyuncs.com
SLS_PRODUCTION_ACCESS_KEY_ID=...
SLS_PRODUCTION_ACCESS_KEY_SECRET=...
SLS_PRODUCTION_PROJECT_NAME=...
SLS_PRODUCTION_LOGSTORE_NAME=...
```

Optional OpenAI-compatible analysis:

```bash
LLM_API_KEY=...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1-mini
```

If `LLM_API_KEY` is omitted, the tool still writes a deterministic local summary.

## Commands

Pull with official SLS SDK:

```bash
bun run pull -- --provider sdk --env alpha,production --from "2h ago" --to now
```

Pull with Aliyun console API cookies:

```bash
bun run pull -- --provider console --env production --from "2h ago" --to now
```

Fetch more pages:

```bash
bun run pull -- --from "2h ago" --to now --line 100 --max-pages 50
```

Pull, filter, cluster, and analyze:

```bash
bun run run -- --provider console --env production --from "2026-05-28 00:00:00+08:00" --to now
```

Analyze an existing pull:

```bash
bun run analyze -- --input artifacts/<window>/analysis-input.json
```

## Time Arguments

`--from` and `--to` support:

- `now`
- `2h ago`, `30m ago`, `1d ago`
- Unix seconds or milliseconds
- ISO timestamps
- `YYYY-MM-DD HH:mm:ss+08:00`

## Outputs

Each run writes to `artifacts/<from>_<to>/`:

- `<env>.raw.jsonl` raw SLS records per environment
- `raw-by-env.json`
- `normalized.json`
- `clusters.json`
- `analysis-input.json`
- `summary.md`

## Query

The default query targets current app remote diagnostic groups:

- `[MotionVideoSkeletonStuck]`
- `[videoPlayerError]`
- `[motionVideoDl]`
- `[LinkVideoDraftTrace]`
- `[FetchNetworkError]`

Override it when needed:

```bash
bun run pull -- --provider console --query "'[motionVideoDl]' and ResponseInterceptor not native_generating"
```

## Console API Provider

Use this when AK/SK is unavailable but browser login can access the SLS console.
Import a fresh browser curl when the cached cookie expires:

```bash
bun run cookie:status -- --env production
bun run cookie:status -- --env production --probe
bun run cookie:import -- --env production --curl-file latest-sls-curl.txt
```

Only one curl is needed. It can be any of the SLS console requests that contains:

- `-b` / `--cookie` or a `cookie:` header
- `x-csrf-token`
- `ProjectName` and `LogStoreName` in `--data-raw`

The importer extracts cookie, CSRF token, referer, user-agent, project, and logstore into:

```txt
.cache/console-auth/<env>.json
```

You can still put these values directly in `.env` if preferred:

```bash
SLS_CONSOLE_PRODUCTION_COOKIE='aliyun_enable_passkey=...; isg=...'
SLS_CONSOLE_PRODUCTION_CSRF_TOKEN=a2a08ebf
SLS_CONSOLE_PRODUCTION_REFERER='https://sls.console.aliyun.com/lognext/project/<project>/logsearch/<logstore>?slsRegion=<region>'
```

The console provider intentionally does not store cookies in run artifacts. It calls the same request family observed from the console:

- `/console/logstoreindex/getLogs.json`
- `/console/logstoreindex/getHistograms.json`
- `/console/logs/getLogs.json`

`/console/logs/getLogs.json` is used as the primary log source. The first two responses are saved to `console-meta-by-env.json` for debugging response shape and count issues. By default the primary query appends `| with_pack_meta`; disable that with:

```bash
bun run pull -- --provider console --with-pack-meta false
```

## Query Cache

Query results are cached before normalization/analysis. Default cache is local file cache:

```bash
QUERY_CACHE_PROVIDER=file
QUERY_CACHE_TTL_SECONDS=3600
```

Disable cache:

```bash
QUERY_CACHE_PROVIDER=none bun run pull -- --provider console --env production --from "2h ago" --to now
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
