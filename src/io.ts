import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

export const writeJsonl = async (path: string, values: unknown[]) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    values.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );
};
