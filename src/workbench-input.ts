export const MAX_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_CONTEXT_CHARS = 80000;
export interface TextAttachment {
  id: string;
  name: string;
  text: string;
}
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'context'; id: string; name: string; text: string }
  | { type: 'image'; asset: import('./workbench-protocol').ImageAsset };
export interface TypedPrompt {
  parts: PromptPart[];
}

/** Explicit user-selected context, never paths to be read by a provider. */
export function composePrompt(text: string, attachments: readonly TextAttachment[]): TypedPrompt {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('Too many attachments');
  let contextChars = 0;
  const ids = new Set<string>();
  const parts: PromptPart[] = text ? [{ type: 'text', text }] : [];
  for (const attachment of attachments) {
    if (
      !attachment.id ||
      ids.has(attachment.id) ||
      attachment.id.length > 200 ||
      !attachment.name ||
      attachment.name.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(attachment.name)
    )
      throw new Error('Invalid attachment identity or source');
    ids.add(attachment.id);
    contextChars += [...attachment.text].length;
    if (
      new TextEncoder().encode(attachment.text).length > MAX_ATTACHMENT_BYTES ||
      contextChars > MAX_CONTEXT_CHARS
    )
      throw new Error('Attachment context budget exceeded');
    parts.push({ type: 'context', ...attachment });
  }
  if (
    (!text.trim() && !attachments.some((part) => part.text.trim())) ||
    [...text].length + contextChars > 100000
  )
    throw new Error('Prompt exceeds context budget');
  return { parts };
}
