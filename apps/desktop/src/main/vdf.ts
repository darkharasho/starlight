export type VdfNode = string | { [key: string]: VdfNode };

/**
 * Tiny tolerant VDF parser. Returns {} on any malformed input rather than throwing.
 * Supports: "key" "value" pairs, "key" { ... } objects, // comments, nested.
 */
export function parseVdf(input: string): Record<string, VdfNode> {
  try {
    let i = 0;
    const skip = (): void => {
      while (i < input.length) {
        const c = input[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
        if (c === '/' && input[i + 1] === '/') {
          while (i < input.length && input[i] !== '\n') i++;
          continue;
        }
        break;
      }
    };
    const readString = (): string | null => {
      skip();
      if (input[i] !== '"') return null;
      i++;
      let out = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) { out += input[i + 1]; i += 2; continue; }
        out += input[i]; i++;
      }
      if (input[i] !== '"') return null;
      i++;
      return out;
    };
    const readObject = (): Record<string, VdfNode> | null => {
      const obj: Record<string, VdfNode> = {};
      skip();
      if (input[i] !== '{') return null;
      i++;
      skip();
      while (i < input.length && input[i] !== '}') {
        const key = readString();
        if (key === null) return null;
        skip();
        if (input[i] === '{') {
          const child = readObject();
          if (child === null) return null;
          obj[key] = child;
        } else {
          const val = readString();
          if (val === null) return null;
          obj[key] = val;
        }
        skip();
      }
      if (input[i] !== '}') return null;
      i++;
      return obj;
    };

    const root: Record<string, VdfNode> = {};
    skip();
    while (i < input.length) {
      const key = readString();
      if (key === null) return {};
      skip();
      if (input[i] === '{') {
        const child = readObject();
        if (child === null) return {};
        root[key] = child;
      } else {
        const val = readString();
        if (val === null) return {};
        root[key] = val;
      }
      skip();
    }
    return root;
  } catch {
    return {};
  }
}
