import {
  analyzeLogs,
  classifySkeletonArtifact,
  getCookieStatus,
  importConsoleCookie,
  queryLogs,
} from "./services";

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]) => {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
};

const argString = (args: Args, key: string) => {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
};

const argNumber = (args: Args, key: string, fallback: number) => {
  const value = argString(args, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
};

const argBoolean = (args: Args, key: string, fallback: boolean) => {
  const value = args[key];
  if (value == null) return fallback;
  if (value === true) return true;
  if (typeof value !== "string") return fallback;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  return fallback;
};

const command = process.argv[2] ?? "run";
const args = parseArgs(process.argv.slice(3));

const main = async () => {
  if (command === "cookie:import") {
    const result = await importConsoleCookie({
      env: argString(args, "env") ?? "production",
      curl: argString(args, "curl"),
      curlFile: argString(args, "curl-file"),
    });
    console.log(
      `[cookie] imported ${result.env}: auth=${result.authEnv} mode=${result.accountMode} project=${result.projectName ?? "-"} logstore=${result.logstoreName ?? "-"} csrf=${result.hasCsrfToken ? "yes" : "no"} envLocal=${result.envLocalChanged.length > 0 ? result.envLocalChanged.join(",") : "unchanged"}`,
    );
    return;
  }

  if (command === "cookie:status" || command === "check-cookie") {
    const statuses = await getCookieStatus({
      env: argString(args, "env"),
      probe: argBoolean(args, "probe", true),
    });
    for (const status of statuses) {
      console.log(JSON.stringify(status, null, 2));
    }
    return;
  }

  if (command === "query" || command === "pull" || command === "run") {
    const result = await queryLogs({
      env: argString(args, "env"),
      from: argString(args, "from"),
      to: argString(args, "to"),
      query: argString(args, "query"),
      line: argNumber(args, "line", 100),
      maxPages: argNumber(args, "max-pages", 20),
      reverse: argBoolean(args, "reverse", false),
      withPackMeta: argBoolean(args, "with-pack-meta", true),
      cache: argBoolean(args, "cache", true),
      out: argString(args, "out"),
      analyze: true,
      cleanupAnalysisInput: true,
    });
    if (result.outputDir) {
      console.log(`[query] wrote ${result.outputDir}`);
      if (result.summaryPath) console.log(`[analyze] wrote ${result.summaryPath}`);
      if (result.conclusionPath) console.log(`[analyze] wrote ${result.conclusionPath}`);
    } else {
      console.log("[query] no logs found, skipped artifact and analysis output");
    }
    return;
  }

  if (command === "analyze") {
    const inputPath =
      argString(args, "input") ??
      (() => {
        throw new Error("Missing --input path to analysis-input.json");
      })();
    const result = await analyzeLogs({
      inputPath,
      summaryPath: argString(args, "summary"),
      conclusionPath: argString(args, "conclusion"),
    });
    console.log(`[analyze] wrote ${result.summaryPath}`);
    console.log(`[analyze] wrote ${result.conclusionPath}`);
    return;
  }

  if (command === "classify:skeleton") {
    const artifactDir =
      argString(args, "artifact") ??
      argString(args, "input") ??
      (() => {
        throw new Error("Missing --artifact path");
      })();
    console.log(JSON.stringify(await classifySkeletonArtifact(artifactDir), null, 2));
    return;
  }

  console.log(`Usage:
  bun run src/index.ts cookie:status -- --env production --probe
  bun run src/index.ts cookie:import -- --env production
  bun run src/index.ts query -- --env production --from "2h ago" --to now
  bun run src/index.ts classify:skeleton -- --artifact artifacts/motion-video-skeleton-102047-week
  bun run src/index.ts analyze -- --input artifacts/.../analysis-input.json
`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
