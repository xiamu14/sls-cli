const RELATIVE_RE = /^(\d+)\s*(m|min|minute|minutes|h|hour|hours|d|day|days)\s*ago$/i;

const unitMs = (unit: string) => {
  switch (unit.toLowerCase()) {
    case "m":
    case "min":
    case "minute":
    case "minutes":
      return 60_000;
    case "h":
    case "hour":
    case "hours":
      return 60 * 60_000;
    case "d":
    case "day":
    case "days":
      return 24 * 60 * 60_000;
    default:
      return 0;
  }
};

export const parseFlexibleDate = (value: string | undefined, fallback: Date) => {
  if (!value) return fallback;

  const text = value.trim();
  if (!text || text.toLowerCase() === "now") return new Date();

  const relative = text.match(RELATIVE_RE);
  if (relative) {
    return new Date(Date.now() - Number(relative[1]) * unitMs(relative[2] ?? ""));
  }

  if (/^\d{10}$/.test(text)) {
    return new Date(Number(text) * 1000);
  }

  if (/^\d{13}$/.test(text)) {
    return new Date(Number(text));
  }

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? text.replace(" ", "T")
    : text;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return parsed;
};

export const toFileStamp = (date = new Date()) =>
  date.toISOString().replace(/[:.]/g, "-");
