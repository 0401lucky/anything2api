export interface ResolvedModel {
  requested: string;
  canonical: string;
  preferredGenerationProvider: string | null;
  streamingMode: "real" | "fake" | "default";
}

const MODEL_ALIASES: Record<string, ResolvedModel> = {
  "anything-auto": {
    requested: "anything-auto",
    canonical: "anything-auto",
    preferredGenerationProvider: null,
    streamingMode: "default",
  },
  openai: {
    requested: "openai",
    canonical: "openai",
    preferredGenerationProvider: "openai",
    streamingMode: "default",
  },
  "gpt-4.1": {
    requested: "gpt-4.1",
    canonical: "openai-gpt-4.1",
    preferredGenerationProvider: "openai-gpt-4.1",
    streamingMode: "default",
  },
  "openai-gpt-4.1": {
    requested: "openai-gpt-4.1",
    canonical: "openai-gpt-4.1",
    preferredGenerationProvider: "openai-gpt-4.1",
    streamingMode: "default",
  },
  "gpt-5.4": {
    requested: "gpt-5.4",
    canonical: "gpt-5.4",
    preferredGenerationProvider: "gpt-5.4",
    streamingMode: "default",
  },
  "gpt-5.2": {
    requested: "gpt-5.2",
    canonical: "gpt-52",
    preferredGenerationProvider: "gpt-52",
    streamingMode: "default",
  },
  gpt52: {
    requested: "gpt52",
    canonical: "gpt-52",
    preferredGenerationProvider: "gpt-52",
    streamingMode: "default",
  },
  "gpt-52": {
    requested: "gpt-52",
    canonical: "gpt-52",
    preferredGenerationProvider: "gpt-52",
    streamingMode: "default",
  },
  "claude-haiku": {
    requested: "claude-haiku",
    canonical: "anthropic-haiku",
    preferredGenerationProvider: "anthropic-haiku",
    streamingMode: "default",
  },
  "anthropic-haiku": {
    requested: "anthropic-haiku",
    canonical: "anthropic-haiku",
    preferredGenerationProvider: "anthropic-haiku",
    streamingMode: "default",
  },
  "claude-3.5-sonnet": {
    requested: "claude-3.5-sonnet",
    canonical: "anthropic-sonnet-3.5",
    preferredGenerationProvider: "anthropic-sonnet-3.5",
    streamingMode: "default",
  },
  "anthropic-sonnet-3.5": {
    requested: "anthropic-sonnet-3.5",
    canonical: "anthropic-sonnet-3.5",
    preferredGenerationProvider: "anthropic-sonnet-3.5",
    streamingMode: "default",
  },
  "claude-3.7-sonnet": {
    requested: "claude-3.7-sonnet",
    canonical: "anthropic-sonnet-3.7",
    preferredGenerationProvider: "anthropic-sonnet-3.7",
    streamingMode: "default",
  },
  "anthropic-sonnet-3.7": {
    requested: "anthropic-sonnet-3.7",
    canonical: "anthropic-sonnet-3.7",
    preferredGenerationProvider: "anthropic-sonnet-3.7",
    streamingMode: "default",
  },
  "claude-sonnet-4": {
    requested: "claude-sonnet-4",
    canonical: "anthropic-sonnet-4",
    preferredGenerationProvider: "anthropic-sonnet-4",
    streamingMode: "default",
  },
  "claude-sonnet-4.6": {
    requested: "claude-sonnet-4.6",
    canonical: "claude-sonnet-4.6",
    preferredGenerationProvider: null,
    streamingMode: "default",
  },
  "claude-sonnet-4-6": {
    requested: "claude-sonnet-4-6",
    canonical: "claude-sonnet-4.6",
    preferredGenerationProvider: null,
    streamingMode: "default",
  },
  "anthropic-sonnet-4.6": {
    requested: "anthropic-sonnet-4.6",
    canonical: "anthropic-sonnet-4.6",
    preferredGenerationProvider: null,
    streamingMode: "default",
  },
  "anthropic-sonnet-4": {
    requested: "anthropic-sonnet-4",
    canonical: "anthropic-sonnet-4",
    preferredGenerationProvider: "anthropic-sonnet-4",
    streamingMode: "default",
  },
  "opus-46": {
    requested: "opus-46",
    canonical: "opus-46",
    preferredGenerationProvider: "opus-46",
    streamingMode: "default",
  },
  "claude-opus-4.6": {
    requested: "claude-opus-4.6",
    canonical: "opus-46",
    preferredGenerationProvider: "opus-46",
    streamingMode: "default",
  },
  "claude-opus-4-6": {
    requested: "claude-opus-4-6",
    canonical: "opus-46",
    preferredGenerationProvider: "opus-46",
    streamingMode: "default",
  },
  "gemini-1.5": {
    requested: "gemini-1.5",
    canonical: "google-1.5",
    preferredGenerationProvider: "google-1.5",
    streamingMode: "default",
  },
  "google-1.5": {
    requested: "google-1.5",
    canonical: "google-1.5",
    preferredGenerationProvider: "google-1.5",
    streamingMode: "default",
  },
  "gemini-2.5-pro": {
    requested: "gemini-2.5-pro",
    canonical: "google-2.5-pro",
    preferredGenerationProvider: "google-2.5-pro",
    streamingMode: "default",
  },
  "google-2.5-pro": {
    requested: "google-2.5-pro",
    canonical: "google-2.5-pro",
    preferredGenerationProvider: "google-2.5-pro",
    streamingMode: "default",
  },
  "gemini-31-pro": {
    requested: "gemini-31-pro",
    canonical: "gemini-31-pro",
    preferredGenerationProvider: "gemini-31-pro",
    streamingMode: "default",
  },
  "gemini-3": {
    requested: "gemini-3",
    canonical: "gemini-3",
    preferredGenerationProvider: "gemini-3",
    streamingMode: "default",
  },
};

for (const key of Object.keys(MODEL_ALIASES)) {
  (MODEL_ALIASES as Record<string, ResolvedModel>)[key] = {
    ...(MODEL_ALIASES[key] as ResolvedModel),
    streamingMode: "default",
  };
}

export const SUPPORTED_MODEL_IDS = [
  "anything-auto",
  "openai",
  "openai-gpt-4.1",
  "gpt-4.1",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-52",
  "anthropic-haiku",
  "claude-haiku",
  "anthropic-sonnet-3.5",
  "claude-3.5-sonnet",
  "anthropic-sonnet-3.7",
  "claude-3.7-sonnet",
  "anthropic-sonnet-4",
  "claude-sonnet-4",
  "anthropic-sonnet-4.6",
  "claude-sonnet-4.6",
  "claude-sonnet-4-6",
  "claude-opus-4.6",
  "claude-opus-4-6",
  "opus-46",
  "google-1.5",
  "gemini-1.5",
  "google-2.5-pro",
  "gemini-2.5-pro",
  "gemini-31-pro",
  "gemini-3",
] as const;

export function resolveModel(input: string | undefined): ResolvedModel {
  const raw = (input ?? "").trim();
  const lower = raw.toLowerCase();

  let stripped = lower;
  let streamingMode: ResolvedModel["streamingMode"] = "default";
  if (stripped.endsWith("-fake")) {
    stripped = stripped.slice(0, -"-fake".length);
    streamingMode = "fake";
  } else if (stripped.endsWith("-real")) {
    stripped = stripped.slice(0, -"-real".length);
    streamingMode = "real";
  }

  const alias = MODEL_ALIASES[stripped];
  if (alias) return { ...alias, streamingMode };

  return {
    requested: raw || "anything-auto",
    canonical: raw || "anything-auto",
    preferredGenerationProvider: null,
    streamingMode,
  };
}
