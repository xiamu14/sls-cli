import type { ConsoleAuthCache, EnvironmentName } from "./types";
import type { CookieBrowserConfig } from "./config";

export type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type CdpRequestSnapshot = {
  url: string;
  headers: Record<string, unknown>;
  postData?: string;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { message?: string };
};

const SLS_REQUEST_PATH =
  /\/(?:common\/getApi|console\/(?:getConfigData|GeneralDataAccessConfig\/getGeneralDataAccessConfig|logstoreindex\/get(?:Logs|Histograms)|logs\/getLogs))\.json(?:\?|$)/;
const SLS_PROFILE_URL = "https://sls.console.aliyun.com/lognext/profile";

export const browserLaunchCommand = (browser: CookieBrowserConfig) => [
  browser.binaryPath,
  `--remote-debugging-port=${browser.remoteDebuggingPort}`,
];

export const isSlsAuthRequest = (url: string) => SLS_REQUEST_PATH.test(url);

const headerValue = (headers: Record<string, unknown>, name: string) => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry && typeof entry[1] === "string" ? entry[1] : undefined;
};

export const buildConsoleAuthFromCdpRequest = (
  env: EnvironmentName,
  request: CdpRequestSnapshot,
  source: ConsoleAuthCache["source"] = "dia-cdp",
): ConsoleAuthCache => {
  const cookie = headerValue(request.headers, "cookie");
  const csrfToken = headerValue(request.headers, "x-csrf-token");
  if (!cookie) throw new Error("Captured SLS request did not include a Cookie header.");
  if (!csrfToken) {
    throw new Error("Captured SLS request did not include an x-csrf-token header.");
  }

  const data = new URLSearchParams(request.postData ?? "");
  const url = new URL(request.url);
  return {
    env,
    cookie,
    csrfToken,
    referer: headerValue(request.headers, "referer"),
    userAgent: headerValue(request.headers, "user-agent"),
    consoleBaseUrl: url.origin,
    projectName: data.get("ProjectName") ?? undefined,
    logstoreName: data.get("LogStoreName") ?? undefined,
    importedAt: new Date().toISOString(),
    source,
  };
};

export const selectSlsTarget = (
  targets: CdpTarget[],
  preferredProject?: string,
) => {
  const candidates = targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      /^https:\/\/sls\.console\.aliyun\.com\//.test(target.url),
  );
  const profile = candidates.find((target) => target.url.startsWith(SLS_PROFILE_URL));
  if (profile) return profile;
  if (preferredProject) {
    const preferred = candidates.find((target) =>
      target.url.includes(`/project/${encodeURIComponent(preferredProject)}/`),
    );
    if (preferred) return preferred;
  }
  return candidates[0];
};

export const isProfileTarget = (target?: CdpTarget) =>
  Boolean(target?.url.startsWith(SLS_PROFILE_URL));

class CdpClient {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private listeners = new Set<(message: CdpMessage) => void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const message = JSON.parse(raw) as CdpMessage;
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "CDP command failed."));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener("close", () => {
      this.pending.clear();
    });
  }

  static connect(url: string) {
    return new Promise<CdpClient>((resolve, reject) => {
      const socket = new WebSocket(url);
      const onError = () => reject(new Error(`Could not connect to browser target: ${url}`));
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.removeEventListener("error", onError);
          resolve(new CdpClient(socket));
        },
        { once: true },
      );
    });
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener: (message: CdpMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

const listTargetsOnce = async (cdpUrl: string): Promise<CdpTarget[]> => {
  const url = `${cdpUrl.replace(/\/$/, "")}/json/list`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Browser CDP target list failed ${response.status}: ${url}`);
  }
  return (await response.json()) as CdpTarget[];
};

const cdpPort = (cdpUrl: string) => {
  const url = new URL(cdpUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return undefined;
  return Number(url.port || 80);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startBrowserCdp = (browser: CookieBrowserConfig) => {
  // ponytail: fire-and-forget; if the browser is already running macOS may ignore the flag.
  Bun.spawn(browserLaunchCommand(browser), {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  }).unref();
};

const quitBrowser = async (browser: CookieBrowserConfig) => {
  await Bun.spawn(["osascript", "-e", `quit app "${browser.appName}"`], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  }).exited;
};

const listTargets = async (
  cdpUrl: string,
  {
    autoLaunch,
    restartBrowser,
    browser,
  }: {
    autoLaunch: boolean;
    restartBrowser: boolean;
    browser: CookieBrowserConfig;
  },
): Promise<CdpTarget[]> => {
  try {
    return await listTargetsOnce(cdpUrl);
  } catch (error) {
    const port = autoLaunch ? cdpPort(cdpUrl) : undefined;
    if (!port) {
      throw new Error(`Could not reach browser CDP at ${cdpUrl}.`, { cause: error });
    }
    if (restartBrowser) {
      await quitBrowser(browser);
      await sleep(1_000);
    }
    startBrowserCdp({ ...browser, remoteDebuggingPort: port });
    for (let index = 0; index < 15; index += 1) {
      await sleep(300);
      try {
        return await listTargetsOnce(cdpUrl);
      } catch {}
    }
    throw new Error(
      `Could not reach ${browser.appName} CDP at ${cdpUrl}. Quit ${browser.appName} and rerun bun run cookie:auto.`,
      { cause: error },
    );
  }
};

const createProfileTarget = async (cdpUrl: string) => {
  const url = `${cdpUrl.replace(/\/$/, "")}/json/new?${encodeURIComponent(SLS_PROFILE_URL)}`;
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Browser could not open the SLS profile page (${response.status}).`);
  }
  return (await response.json()) as CdpTarget;
};

export const captureConsoleAuthFromBrowser = async ({
  browser,
  cdpUrl = browser.cdpUrl,
  timeoutMs = 30_000,
  authEnv = "single",
  autoLaunch = true,
  restartBrowser = true,
}: {
  browser: CookieBrowserConfig;
  cdpUrl?: string;
  timeoutMs?: number;
  authEnv?: EnvironmentName;
  autoLaunch?: boolean;
  restartBrowser?: boolean;
}) => {
  await listTargets(cdpUrl, { autoLaunch, restartBrowser, browser });
  const target = await createProfileTarget(cdpUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      "Browser opened the SLS profile page but did not expose a debuggable page target.",
    );
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const requests = new Map<string, CdpRequestSnapshot>();
  const extraHeaders = new Map<string, Record<string, unknown>>();
  let sawLoginRedirect = false;

  try {
    return await new Promise<ConsoleAuthCache>(async (resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        action();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                sawLoginRedirect
                  ? `${browser.appName} opened the Aliyun login page. Log in, then rerun bun run cookie:auto.`
                  : `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for an SLS request in ${browser.appName}.`,
              ),
            ),
          ),
        timeoutMs,
      );

      const tryResolve = async (requestId: string) => {
        const request = requests.get(requestId);
        if (!request) return;
        request.headers = {
          ...request.headers,
          ...extraHeaders.get(requestId),
        };
        if (!request.postData) {
          try {
            const result = await client.send("Network.getRequestPostData", { requestId });
            request.postData = result?.postData;
          } catch {}
        }
        try {
          const auth = buildConsoleAuthFromCdpRequest(
            authEnv,
            request,
            browser.name === "chrome" ? "chrome-cdp" : "dia-cdp",
          );
          finish(() => resolve(auth));
        } catch {}
      };

      const unsubscribe = client.onEvent((message) => {
        const requestId = message.params?.requestId;
        if (typeof requestId !== "string") return;

        if (message.method === "Network.requestWillBeSentExtraInfo") {
          const headers = message.params?.headers;
          const associatedCookies = message.params?.associatedCookies;
          const cookieFromList = Array.isArray(associatedCookies)
            ? associatedCookies
                .map((item) => item?.cookie)
                .filter((cookie) => cookie?.name && typeof cookie.value === "string")
                .map((cookie) => `${cookie.name}=${cookie.value}`)
                .join("; ")
            : "";
          extraHeaders.set(requestId, {
            ...(headers && typeof headers === "object" ? headers : {}),
            ...(cookieFromList ? { cookie: cookieFromList } : {}),
          });
          void tryResolve(requestId);
          return;
        }

        if (message.method !== "Network.requestWillBeSent") return;
        const request = message.params?.request;
        if (!request || typeof request.url !== "string") return;
        if (/https:\/\/(?:signin|account)\.aliyun\.com\//.test(request.url)) {
          sawLoginRedirect = true;
        }
        if (!isSlsAuthRequest(request.url)) {
          return;
        }
        requests.set(requestId, {
          url: request.url,
          headers: request.headers ?? {},
          postData: request.postData,
        });
        void tryResolve(requestId);
      });

      try {
        await client.send("Network.enable", { maxPostDataSize: 1_048_576 });
        await client.send("Page.enable");
        await client.send("Page.navigate", { url: SLS_PROFILE_URL });
        await client.send("Page.reload", { ignoreCache: true });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  } finally {
    client.close();
  }
};
