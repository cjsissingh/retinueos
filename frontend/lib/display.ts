const DISPLAY_WORDS = new Map([
  ["gmail", "Gmail"],
  ["mcp", "MCP"],
  ["oauth", "OAuth"],
  ["url", "URL"],
]);

function displayWord(word: string): string {
  return DISPLAY_WORDS.get(word.toLowerCase()) ?? word.toLowerCase();
}

/** Transport-qualified tool id → action label an operator can scan. */
export function displayToolName(toolId: string): string {
  const rawName = toolId.split(":").at(-1) ?? toolId;
  const words = rawName
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(displayWord);
  const phrase = words.join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function displayEnum(value: string): string {
  const phrase = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function displayModelName(provider: string, model: string): string {
  const modelId = model.trim() || provider;
  const gptMatch = modelId.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (gptMatch) {
    const suffix = gptMatch[2] ? ` ${displayEnum(gptMatch[2])}` : "";
    return `GPT-${gptMatch[1]}${suffix}`;
  }
  const source = modelId.replace(/-(\d+)-(\d+)$/, " $1.$2");
  const words = source
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word.toLowerCase() === "gpt") return "GPT";
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
  return words.join(" ");
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function relativeTime(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
