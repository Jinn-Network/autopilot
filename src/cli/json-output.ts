export function parseTrailingJson(output: string): unknown {
  const candidate = output.trim();
  for (
    let index = candidate.lastIndexOf('{');
    index >= 0;
    index = candidate.lastIndexOf('{', index - 1)
  ) {
    try {
      return JSON.parse(candidate.slice(index)) as unknown;
    } catch {
      // Pretty-printed nested objects fail until the root opening brace is tried.
    }
  }
  throw new Error('Lifecycle engine did not return a JSON report');
}
