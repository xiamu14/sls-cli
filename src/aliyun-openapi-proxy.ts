import { loadAliyunApiAuthCache } from "./aliyun-api-auth";
import type { EnvironmentName, StsCredentialCache } from "./types";

type OpenApiProxyRequest = {
  action: string;
  product: string;
  apiVersion: string;
  endpoint: string;
  regionId: string;
  params?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

export const callAliyunOpenApiProxy = async (
  env: EnvironmentName,
  request: OpenApiProxyRequest,
) => {
  const auth = loadAliyunApiAuthCache(env);
  if (!auth) {
    throw new Error(`Missing Aliyun API auth cache for ${env}. Run api-cookie:import.`);
  }

  const response = await fetch(`${auth.origin}/api/auth/product/openAPIRequest`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/json",
      cookie: auth.cookie,
      origin: auth.origin,
      referer:
        auth.referer ??
        `${auth.origin}/api/${request.product}/${request.apiVersion}/${request.action}?tab=DEBUG`,
      "user-agent":
        auth.userAgent ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      ...(auth.csrfToken ? { "x-csrf-token": auth.csrfToken } : {}),
    },
    body: JSON.stringify({
      action: request.action,
      product: request.product,
      bodyStyle: null,
      apiStyle: "RPC",
      apiVersion: request.apiVersion,
      accessKeyId: null,
      proxyEndpoint: "https://popunify-inner-pre.aliyuncs.com",
      endpoint: request.endpoint,
      regionId: request.regionId,
      paramObject: {
        method: "POST|GET",
        path: "/",
        params: "[]",
        protocol: "HTTPS",
      },
      params: request.params ?? {},
      credential: {
        type: "ak",
      },
    }),
  });

  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!response.ok) {
    throw new Error(
      `[aliyun-api] ${request.product}.${request.action} failed ${response.status}: ${text.slice(0, 1000)}`,
    );
  }

  return json;
};

const findCredentials = (value: unknown): Record<string, unknown> | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCredentials(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    typeof value.AccessKeyId === "string" &&
    typeof value.AccessKeySecret === "string" &&
    typeof value.SecurityToken === "string"
  ) {
    return value;
  }
  if (isRecord(value.Credentials)) return findCredentials(value.Credentials);
  if (typeof value.body === "string") {
    try {
      return findCredentials(JSON.parse(value.body));
    } catch {}
  }
  for (const item of Object.values(value)) {
    const found = findCredentials(item);
    if (found) return found;
  }
  return undefined;
};

export const getCallerIdentityViaProxy = (env: EnvironmentName) =>
  callAliyunOpenApiProxy(env, {
    action: "GetCallerIdentity",
    product: "Sts",
    apiVersion: "2015-04-01",
    endpoint: "sts.cn-hangzhou.aliyuncs.com",
    regionId: "cn-hangzhou",
  });

export const assumeRoleViaProxy = async ({
  env,
  roleArn,
  roleSessionName,
  durationSeconds,
}: {
  env: EnvironmentName;
  roleArn: string;
  roleSessionName: string;
  durationSeconds: number;
}): Promise<StsCredentialCache> => {
  const response = await callAliyunOpenApiProxy(env, {
    action: "AssumeRole",
    product: "Sts",
    apiVersion: "2015-04-01",
    endpoint: "sts.cn-hangzhou.aliyuncs.com",
    regionId: "cn-hangzhou",
    params: {
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      DurationSeconds: durationSeconds,
    },
  });
  const credentials = findCredentials(response);
  if (!credentials) {
    throw new Error(
      `AssumeRole succeeded but credentials were not found in response: ${JSON.stringify(response).slice(0, 1000)}`,
    );
  }
  return {
    env,
    accessKeyId: String(credentials.AccessKeyId),
    accessKeySecret: String(credentials.AccessKeySecret),
    securityToken: String(credentials.SecurityToken),
    expiration:
      typeof credentials.Expiration === "string" ? credentials.Expiration : undefined,
    roleArn,
    roleSessionName,
    importedAt: new Date().toISOString(),
    source: "assume-role",
  };
};
