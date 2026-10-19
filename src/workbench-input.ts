export const MAX_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_CONTEXT_CHARS = 80000;
export interface TextAttachment {
  id: string;
  name: string;
  text: string;
}
export function composePrompt(text: string, attachments: readonly TextAttachment[]) {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('Too many attachments');
  let contextChars = 0;
  const parts = attachments.map((attachment) => {
    contextChars += [...attachment.text].length;
    if (contextChars > MAX_CONTEXT_CHARS) throw new Error('Attachment context budget exceeded');
    return `Explicit file attachment: ${attachment.name}

${attachment.text}`;
  });
  const result = [text, ...parts].filter(Boolean).join('\n\n');
  if (!result.trim() || [...result].length > 100000)
    throw new Error('Prompt exceeds context budget');
  return result;
}
