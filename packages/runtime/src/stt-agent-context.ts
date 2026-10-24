export const MAX_RUNTIME_STT_AGENT_CONTEXT_CHARACTERS = 1_500;

export function boundSttAgentContext(context: string): string {
  let start = context.length;
  let count = 0;
  while (start > 0 && count < MAX_RUNTIME_STT_AGENT_CONTEXT_CHARACTERS) {
    start -= 1;
    const codeUnit = context.charCodeAt(start);
    if (
      codeUnit >= 0xdc00 &&
      codeUnit <= 0xdfff &&
      start > 0 &&
      context.charCodeAt(start - 1) >= 0xd800 &&
      context.charCodeAt(start - 1) <= 0xdbff
    ) {
      start -= 1;
    }
    count += 1;
  }
  return start === 0 ? context : context.slice(start);
}
