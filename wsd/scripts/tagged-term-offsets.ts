export function taggedTermStarts(
  context: string,
  terms: ReadonlyArray<{ raw: string }>,
): Array<number | null> {
  let cursor = 0;
  return terms.map((term) => {
    const start = context.indexOf(term.raw, cursor);
    if (start < 0) {
      // The tagger can expand a contraction (for example, ’em to "them").
      return null;
    }
    cursor = start + term.raw.length;
    return start;
  });
}
