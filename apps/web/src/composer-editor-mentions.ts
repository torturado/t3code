export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "path";
      value: string;
    }
  | {
      type: "skill";
      value: string;
    };

const TOKEN_REGEX = /(^|\s)([@$])([^\s@$]+)(?=\s)/g;

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

export function splitPromptIntoComposerSegments(prompt: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!prompt) {
    return segments;
  }

  let cursor = 0;
  for (const match of prompt.matchAll(TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const sigil = match[2] ?? "";
    const value = match[3] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;

    if (mentionStart > cursor) {
      pushTextSegment(segments, prompt.slice(cursor, mentionStart));
    }

    if (value.length > 0) {
      segments.push({
        type: sigil === "$" ? "skill" : "path",
        value,
      });
    } else {
      pushTextSegment(segments, prompt.slice(mentionStart, mentionEnd));
    }

    cursor = mentionEnd;
  }

  if (cursor < prompt.length) {
    pushTextSegment(segments, prompt.slice(cursor));
  }

  return segments;
}
