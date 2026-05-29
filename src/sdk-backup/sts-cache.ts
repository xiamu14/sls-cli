import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { EnvironmentName, StsCredentialCache } from "../types";

const cachePath = (env: EnvironmentName) =>
  resolve(process.cwd(), ".cache", "sts", `${env}.json`);

export const saveStsCredentialCache = async (credential: StsCredentialCache) => {
  const path = cachePath(credential.env);
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
};

export const loadStsCredentialCache = (
  env: EnvironmentName,
): StsCredentialCache | undefined => {
  const path = cachePath(env);
  if (!existsSync(path)) return undefined;
  const credential = JSON.parse(readFileSync(path, "utf8")) as StsCredentialCache;
  if (credential.expiration) {
    const expiresAt = new Date(credential.expiration).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000) {
      return undefined;
    }
  }
  return credential;
};

export const getStsCredentialCacheStatus = (env: EnvironmentName) => {
  const path = cachePath(env);
  const credential = loadStsCredentialCache(env);
  if (!credential) return { env, path, exists: existsSync(path), valid: false };
  return {
    env,
    path,
    exists: true,
    valid: true,
    importedAt: credential.importedAt,
    expiration: credential.expiration,
    roleArn: credential.roleArn,
    roleSessionName: credential.roleSessionName,
    accessKeyIdPrefix: credential.accessKeyId.slice(0, 8),
    hasSecurityToken: Boolean(credential.securityToken),
  };
};
