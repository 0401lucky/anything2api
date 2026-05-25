export interface CleanedAssistantOutput {
  content: string;
  reasoning: string;
  raw: string;
}

const FILE_BLOCK_PATTERN =
  /<file-based-block\b([^>]*)>([\s\S]*?)<\/file-based-block>/gi;

export function cleanAssistantOutput(raw: string): CleanedAssistantOutput {
  const reasoningParts: string[] = [];

  const withoutBlocks = raw.replace(FILE_BLOCK_PATTERN, (_match, attrs: string, inner: string) => {
    const isReasoning =
      /thinkingType\s*=\s*"reasoning"/i.test(attrs) ||
      /uiType\s*=\s*"thinking"/i.test(attrs);

    if (isReasoning) {
      const textAttr = extractAttribute(attrs, "text");
      const subtextAttr = extractAttribute(attrs, "subtext");
      const innerText = stripTags(decodeHtmlEntities(inner));
      const parts = [textAttr, subtextAttr, innerText]
        .map((part) => normalizeWhitespace(part))
        .filter(Boolean);

      if (parts.length > 0) {
        reasoningParts.push(parts.join("\n\n"));
      }
      return "";
    }

    return inner;
  });

  return {
    raw,
    content: normalizeWhitespace(stripTags(decodeHtmlEntities(withoutBlocks))),
    reasoning: normalizeWhitespace(reasoningParts.join("\n\n")),
  };
}

function extractAttribute(attrs: string, name: string): string {
  const pattern = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  return decodeHtmlEntities(pattern.exec(attrs)?.[1] ?? "");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}
