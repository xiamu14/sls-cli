export type EnvironmentName = "alpha" | "production" | string;

export type SlsEnvConfig = {
  env: EnvironmentName;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  projectName: string;
  logstoreName: string;
  securityToken?: string;
};

export type SlsConsoleEnvConfig = {
  env: EnvironmentName;
  accountMode: "single" | "environment";
  authEnv: EnvironmentName;
  consoleBaseUrl: string;
  projectName: string;
  logstoreName: string;
  cookie: string;
  csrfToken: string;
  referer?: string;
  userAgent: string;
};

export type ConsoleAuthCache = {
  env: EnvironmentName;
  cookie: string;
  csrfToken: string;
  referer?: string;
  userAgent?: string;
  consoleBaseUrl?: string;
  projectName?: string;
  logstoreName?: string;
  importedAt: string;
  source: "curl" | "manual" | "dia-cdp" | "chrome-cdp";
};

export type AliyunApiAuthCache = {
  env: EnvironmentName;
  cookie: string;
  csrfToken?: string;
  referer?: string;
  userAgent?: string;
  origin: string;
  importedAt: string;
  source: "curl" | "manual";
};

export type StsCredentialCache = {
  env: EnvironmentName;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration?: string;
  roleArn?: string;
  roleSessionName?: string;
  importedAt: string;
  source: "assume-role" | "manual";
};

export type PullOptions = {
  envs: EnvironmentName[];
  from: Date;
  to: Date;
  query: string;
  line: number;
  reverse: boolean;
  outputDir: string;
};

export type RawSlsRecord = Record<string, unknown>;

export type ConsolePullMeta = {
  env: EnvironmentName;
  indexLogsResponse?: unknown;
  histogramsResponse?: unknown;
  packedLogsResponse?: unknown;
};

export type NormalizedLog = {
  env: EnvironmentName;
  source: RawSlsRecord;
  receiveTime?: number;
  time?: string;
  group: string;
  type?: string;
  payload: unknown;
  payloadParseError?: string;
  event?: string;
  scope?: string;
  projectId?: string;
  userId?: string;
  traceId?: string;
  sessionId?: string;
  fingerprint: string;
};

export type LogCluster = {
  fingerprint: string;
  group: string;
  event?: string;
  scope?: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  envs: string[];
  projectIds: string[];
  userIds: string[];
  samples: NormalizedLog[];
};

export type AnalysisInput = {
  generatedAt: string;
  window: {
    from: string;
    to: string;
  };
  envs: EnvironmentName[];
  query: string;
  provider?: string;
  rawCount: number;
  normalizedCount: number;
  clusters: LogCluster[];
};
