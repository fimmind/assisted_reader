export function taggedTermStarts(
  context: string,
  terms: ReadonlyArray<{ raw: string }>,
): number[] {
  let cursor = 0;
  return terms.map((term) => {
    const start = context.indexOf(term.raw, cursor);
    if (start < 0) {
      throw new Error(
        `Tagged term is absent from context: term=${JSON.stringify(term.raw)} cursor=${cursor}`,
      );
    }
    cursor = start + term.raw.length;
    return start;
  });
}
