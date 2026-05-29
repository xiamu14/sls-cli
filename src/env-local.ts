import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ConsoleAuthCache, EnvironmentName } from "./types";

const envLocalPath = () => resolve(process.cwd(), ".env.local");

const upperEnv = (env: string) => env.toUpperCase().replace(/[^A-Z0-9]/g, "_");

const parseEnvText = (text: string) => {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
};

const setLine = (lines: string[], key: string, value: string) => {
  const nextLine = `${key}=${value}`;
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = nextLine;
    return false;
  }
  lines.push(nextLine);
  return true;
};

const requireConsistent = ({
  values,
  key,
  nextValue,
  env,
}: {
  values: Map<string, string>;
  key: string;
  nextValue: string;
  env: EnvironmentName;
}) => {
  const existing = values.get(key);
  if (!existing || existing === nextValue) return;
  throw new Error(
    `.env.local ${key}=${existing} does not match ${env} cURL value ${nextValue}. ` +
      `Check whether the cURL belongs to ${env}, or update .env.local intentionally.`,
  );
};

const extractRegionFromReferer = (referer?: string) =>
  referer?.match(/[?&]slsRegion=([^&]+)/)?.[1];

export const syncConsoleCurlToEnvLocal = ({
  env,
  auth,
}: {
  env: EnvironmentName;
  auth: ConsoleAuthCache;
}) => {
  if (!auth.projectName || !auth.logstoreName) {
    throw new Error(
      "Could not find ProjectName/LogStoreName in cURL --data-raw. Copy one SLS console request for the target environment.",
    );
  }

  const path = envLocalPath();
  const existingText = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existingText ? existingText.replace(/\n$/, "").split(/\r?\n/) : [];
  const values = parseEnvText(existingText);
  const prefix = `SLS_${upperEnv(env)}`;
  const projectKey = `${prefix}_PROJECT_NAME`;
  const logstoreKey = `${prefix}_LOGSTORE_NAME`;
  const regionKey = `${prefix}_REGION`;
  const region = extractRegionFromReferer(auth.referer);

  requireConsistent({ values, key: projectKey, nextValue: auth.projectName, env });
  requireConsistent({ values, key: logstoreKey, nextValue: auth.logstoreName, env });
  if (region) requireConsistent({ values, key: regionKey, nextValue: region, env });

  const changed: string[] = [];
  if (setLine(lines, projectKey, auth.projectName)) changed.push(projectKey);
  if (setLine(lines, logstoreKey, auth.logstoreName)) changed.push(logstoreKey);
  if (region && setLine(lines, regionKey, region)) changed.push(regionKey);

  if (!values.has("SLS_ACCOUNT_MODE") && !values.has("ACCOUNT_MODE")) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("SLS_ACCOUNT_MODE=single");
    changed.push("SLS_ACCOUNT_MODE");
  }

  if (changed.length > 0) {
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  }

  return {
    path,
    changed,
    projectName: auth.projectName,
    logstoreName: auth.logstoreName,
    region,
  };
};
