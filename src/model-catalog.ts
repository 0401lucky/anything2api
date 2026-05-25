export interface ResolvedModel {
  requested: string;
  canonical: string;
  preferredGenerationProvider: string | null;
}

const MODEL_ALIASES: Record<string, ResolvedModel> = {
  "anything-auto": {
    requested: "anything-auto",
    canonical: "anything-auto",
    preferredGenerationProvider: null,
  },
  openai: {
    requested: "openai",
    canonical: "openai",
    preferredGenerationProvider: "openai",
  },
  "gpt-4.1": {
    requested: "gpt-4.1",
    canonical: "openai-gpt-4.1",
    preferredGenerationProvider: "openai-gpt-4.1",
  },
  "openai-gpt-4.1": {
    requested: "openai-gpt-4.1",
    canonical: "openai-gpt-4.1",
    preferredGenerationProvider: "openai-gpt-4.1",
  },
  "gpt-5.4": {
    requested: "gpt-5.4",
    canonical: "gpt-5.4",
    preferredGenerationProvider: "gpt-5.4",
  },
  "gpt-5.2": {
    requested: "gpt-5.2",
    canonical: "gpt-52",
    preferredGenerationProvider: "gpt-52",
  },
  gpt52: {
    requested: "gpt52",
    canonical: "gpt-52",
    preferredGenerationProvider: "gpt-52",
  },
  "gpt-52": {
    requested: "gpt-52",
    canonical: "gpt-52",
    preferredGenerationProvider: "gpt-52",
  },
  "claude-haiku": {
    requested: "claude-haiku",
    canonical: "anthropic-haiku",
    preferredGenerationProvider: "anthropic-haiku",
  },
  "anthropic-haiku": {
    requested: "anthropic-haiku",
    canonical: "anthropic-haiku",
    preferredGenerationProvider: "anthropic-haiku",
  },
  "claude-3.5-sonnet": {
    requested: "claude-3.5-sonnet",
    canonical: "anthropic-sonnet-3.5",
    preferredGenerationProvider: "anthropic-sonnet-3.5",
  },
  "anthropic-sonnet-3.5": {
    requested: "anthropic-sonnet-3.5",
    canonical: "anthropic-sonnet-3.5",
    preferredGenerationProvider: "anthropic-sonnet-3.5",
  },
  "claude-3.7-sonnet": {
    requested: "claude-3.7-sonnet",
    canonical: "anthropic-sonnet-3.7",
    preferredGenerationProvider: "anthropic-sonnet-3.7",
  },
  "anthropic-sonnet-3.7": {
    requested: "anthropic-sonnet-3.7",
    canonical: "anthropic-sonnet-3.7",
    preferredGenerationProvider: "anthropic-sonnet-3.7",
  },
  "claude-sonnet-4": {
    requested: "claude-sonnet-4",
    canonical: "anthropic-sonnet-4",
    preferredGenerationProvider: "anthropic-sonnet-4",
  },
  "claude-sonnet-4.6": {
    requested: "claude-sonnet-4.6",
    canonical: "claude-sonnet-4.6",
    preferredGenerationProvider: null,
  },
  "claude-sonnet-4-6": {
    requested: "claude-sonnet-4-6",
    canonical: "claude-sonnet-4.6",
    preferredGenerationProvider: null,
  },
  "anthropic-sonnet-4.6": {
    requested: "anthropic-sonnet-4.6",
    canonical: "anthropic-sonnet-4.6",
    preferredGenerationProvider: null,
  },
  "anthropic-sonnet-4": {
    requested: "anthropic-sonnet-4",
    canonical: "anthropic-sonnet-4",
    preferredGenerationProvider: "anthropic-sonnet-4",
  },
  "opus-46": {
    requested: "opus-46",
    canonical: "opus-46",
    preferredGenerationProvider: "opus-46",
  },
  "claude-opus-4.6": {
    requested: "claude-opus-4.6",
    canonical: "opus-46",
    preferredGenerationProvider: "opus-46",
  },
  "claude-opus-4-6": {
    requested: "claude-opus-4-6",
    canonical: "opus-46",
    preferredGenerationProvider: "opus-46",
  },
  "gemini-1.5": {
    requested: "gemini-1.5",
    canonical: "google-1.5",
    preferredGenerationProvider: "google-1.5",
  },
  "google-1.5": {
    requested: "google-1.5",
    canonical: "google-1.5",
    preferredGenerationProvider: "google-1.5",
  },
  "gemini-2.5-pro": {
    requested: "gemini-2.5-pro",
    canonical: "google-2.5-pro",
    preferredGenerationProvider: "google-2.5-pro",
  },
  "google-2.5-pro": {
    requested: "google-2.5-pro",
    canonical: "google-2.5-pro",
    preferredGenerationProvider: "google-2.5-pro",
  },
  "gemini-31-pro": {
    requested: "gemini-31-pro",
    canonical: "gemini-31-pro",
    preferredGenerationProvider: "gemini-31-pro",
  },
  "gemini-3": {
    requested: "gemini-3",
    canonical: "gemini-3",
    preferredGenerationProvider: "gemini-3",
  },
};

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
  const normalized = normalizeModelName(input);
  return (
    MODEL_ALIASES[normalized] ?? {
      requested: input?.trim() || "anything-auto",
      canonical: input?.trim() || "anything-auto",
      preferredGenerationProvider: null,
    }
  );
}

function normalizeModelName(input: string | undefined): string {
  return (input ?? "").trim().toLowerCase();
}
