import type { ConsoleAuthCache, EnvironmentName } from "./types";

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
const DIA_BINARY = "/Applications/Dia.app/Contents/MacOS/Dia";

export const diaLaunchCommand = (port: number) => [
  DIA_BINARY,
  `--remote-debugging-port=${port}`,
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
    source: "dia-cdp",
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
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Dia closed the CDP connection."));
      }
      this.pending.clear();
    });
  }

  static connect(url: string) {
    return new Promise<CdpClient>((resolve, reject) => {
      const socket = new WebSocket(url);
      const onError = () => reject(new Error(`Could not connect to Dia target: ${url}`));
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
    throw new Error(`Dia CDP target list failed ${response.status}: ${url}`);
  }
  return (await response.json()) as CdpTarget[];
};

const cdpPort = (cdpUrl: string) => {
  const url = new URL(cdpUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return undefined;
  return Number(url.port || 80);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startDiaCdp = (port: number) => {
  // ponytail: fire-and-forget; if Dia is already running macOS may ignore the flag.
  Bun.spawn(diaLaunchCommand(port), {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  }).unref();
};

const quitDia = async () => {
  await Bun.spawn(["osascript", "-e", 'quit app "Dia"'], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  }).exited;
};

const listTargets = async (
  cdpUrl: string,
  { autoLaunch, restartDia }: { autoLaunch: boolean; restartDia: boolean },
): Promise<CdpTarget[]> => {
  try {
    return await listTargetsOnce(cdpUrl);
  } catch (error) {
    const port = autoLaunch ? cdpPort(cdpUrl) : undefined;
    if (!port) {
      throw new Error(`Could not reach Dia CDP at ${cdpUrl}.`, { cause: error });
    }
    if (restartDia) {
      await quitDia();
      await sleep(1_000);
    }
    startDiaCdp(port);
    for (let index = 0; index < 15; index += 1) {
      await sleep(300);
      try {
        return await listTargetsOnce(cdpUrl);
      } catch {}
    }
    throw new Error(
      `Could not reach Dia CDP at ${cdpUrl}. Quit Dia and rerun bun run cookie:auto.`,
      { cause: error },
    );
  }
};

const createProfileTarget = async (cdpUrl: string) => {
  const url = `${cdpUrl.replace(/\/$/, "")}/json/new?${encodeURIComponent(SLS_PROFILE_URL)}`;
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Dia could not open the SLS profile page (${response.status}).`);
  }
  return (await response.json()) as CdpTarget;
};

export const captureConsoleAuthFromDia = async ({
  cdpUrl = "http://127.0.0.1:9222",
  preferredProject,
  timeoutMs = 30_000,
  authEnv = "single",
  autoLaunch = true,
  restartDia = true,
}: {
  cdpUrl?: string;
  preferredProject?: string;
  timeoutMs?: number;
  authEnv?: EnvironmentName;
  autoLaunch?: boolean;
  restartDia?: boolean;
} = {}) => {
  const targets = await listTargets(cdpUrl, { autoLaunch, restartDia });
  const selected = selectSlsTarget(targets, preferredProject);
  const target = isProfileTarget(selected) ? selected : await createProfileTarget(cdpUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      "Dia opened the SLS profile page but did not expose a debuggable page target.",
    );
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const requests = new Map<string, CdpRequestSnapshot>();
  const extraHeaders = new Map<string, Record<string, unknown>>();

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
                `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for an SLS request in Dia.`,
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
          const auth = buildConsoleAuthFromCdpRequest(authEnv, request);
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
        if (!request || typeof request.url !== "string" || !isSlsAuthRequest(request.url)) {
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
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  } finally {
    client.close();
  }
};
