// Scan the original tokens before JSON.parse can collapse duplicate members.
// A sticky match stops at a malformed string instead of searching its suffix.
export function parseStrictJson(bytes: Uint8Array, maxBytes: number, maxDepth: number, maxMembers: number): unknown {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maxBytes) throw new Error('Invalid JSON size.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const tokens = /"(?:[^"\\]|\\.)*"[ \t\r\n]*:?|[[\]{}]|[^"[\]{}]+/gy;
  const stack: (Set<string> | null)[] = [];
  while (tokens.lastIndex < source.length) {
    const match = tokens.exec(source);
    if (!match) throw new Error('Invalid JSON token.');
    const token = match[0];
    if (token === '{' || token === '[') {
      if (stack.length >= maxDepth) throw new Error('Invalid JSON depth.');
      stack.push(token === '{' ? new Set<string>() : null);
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else if (token.startsWith('"') && token.endsWith(':')) {
      const members = stack.at(-1);
      const key: string = JSON.parse(token.slice(0, -1));
      if (!members || members.size >= maxMembers || members.has(key)) throw new Error('Invalid JSON members.');
      members.add(key);
    }
  }
  return JSON.parse(source);
}
