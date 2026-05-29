import net from "node:net";

const encodeResp = (parts: string[]) =>
  `*${parts.length}\r\n${parts
    .map((part) => {
      const bytes = Buffer.byteLength(part);
      return `$${bytes}\r\n${part}\r\n`;
    })
    .join("")}`;

const parseBulk = (buffer: Buffer) => {
  const text = buffer.toString("utf8");
  if (text.startsWith("$-1")) return undefined;
  if (text.startsWith("+")) return text.slice(1).trim();
  if (text.startsWith(":")) return text.slice(1).trim();
  if (!text.startsWith("$")) return undefined;
  const headerEnd = text.indexOf("\r\n");
  const length = Number(text.slice(1, headerEnd));
  if (!Number.isFinite(length) || length < 0) return undefined;
  return text.slice(headerEnd + 2, headerEnd + 2 + length);
};

const command = async (
  urlValue: string,
  parts: string[],
): Promise<string | undefined> => {
  const url = new URL(urlValue);
  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port || 6379);
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const db = url.pathname.replace("/", "");
  const commands = [
    ...(password ? [["AUTH", password]] : []),
    ...(db ? [["SELECT", db]] : []),
    parts,
  ];

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let commandIndex = 0;

    const sendNext = () => {
      const next = commands[commandIndex];
      if (!next) {
        socket.end();
        resolve(parseBulk(Buffer.concat(chunks)));
        return;
      }
      chunks.length = 0;
      socket.write(encodeResp(next));
      commandIndex += 1;
    };

    socket.setTimeout(1500);
    socket.on("connect", sendNext);
    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      sendNext();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Valkey command timed out"));
    });
    socket.on("error", reject);
  });
};

export const valkeyGet = async (key: string) => {
  const url = process.env.VALKEY_URL;
  if (!url) return undefined;
  return await command(url, ["GET", key]);
};

export const valkeySetEx = async (key: string, seconds: number, value: string) => {
  const url = process.env.VALKEY_URL;
  if (!url) return;
  await command(url, ["SETEX", key, String(seconds), value]);
};
