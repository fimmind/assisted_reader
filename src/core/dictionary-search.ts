import { loadLemmaDict } from './lemma';
import { loadWiktionaryLexicon, loadWordNet } from './lexicon';
import type { WordNetEntry } from './lexicon';
import { normalizeToken } from './math';
import { LEMMA_INFLECTION_INDEX } from './types';
import type { LexiconEntry, PartOfSpeech } from './types';

type DictionarySource = 'WordNet' | 'Wiktionary' | 'WordNet and Wiktionary';

interface DictionarySenseGroup {
  partOfSpeech: PartOfSpeech;
  source: DictionarySource;
  definitions: string[];
}

interface DictionaryResult {
  word: string;
  senses: DictionarySenseGroup[];
}

interface HeadwordLookup {
  word: string;
  wordNet: WordNetEntry | null;
  wiktionary: LexiconEntry | null;
}

async function lookupHeadword(word: string): Promise<HeadwordLookup> {
  const [wordNet, wiktionary] = await Promise.all([
    loadWordNet().lookup(word),
    loadWiktionaryLexicon().lookup(word),
  ]);
  return { word, wordNet, wiktionary };
}

function groupDefinitions({ word, wordNet, wiktionary }: HeadwordLookup, omittedSynsetIds: ReadonlySet<string>): DictionaryResult {
  const wordNetSenses = wordNet?.senses ?? [];
  const wiktionarySenses = wiktionary?.senses ?? [];
  const partsOfSpeech = new Set<PartOfSpeech>([
    ...wordNetSenses.map((sense) => sense.partOfSpeech),
    ...wiktionarySenses.map((sense) => sense.partOfSpeech),
  ]);
  const senses: DictionarySenseGroup[] = [];
  for (const partOfSpeech of partsOfSpeech) {
    const wordNetDefinitions = new Set(wordNetSenses
      .filter((sense) => sense.partOfSpeech === partOfSpeech)
      .flatMap((sense) => sense.definitions)
      .filter((definition) => !omittedSynsetIds.has(definition.id))
      .map((definition) => definition.gloss));
    const wiktionaryDefinitions = new Set(wiktionarySenses
      .filter((sense) => sense.partOfSpeech === partOfSpeech)
      .flatMap((sense) => sense.definitions));
    const bySource: Record<DictionarySource, string[]> = {
      WordNet: [...wordNetDefinitions].filter((definition) => !wiktionaryDefinitions.has(definition)),
      Wiktionary: [...wiktionaryDefinitions].filter((definition) => !wordNetDefinitions.has(definition)),
      'WordNet and Wiktionary': [...wordNetDefinitions].filter((definition) => wiktionaryDefinitions.has(definition)),
    };
    for (const source of ['WordNet', 'Wiktionary', 'WordNet and Wiktionary'] as const) {
      const definitions = bySource[source];
      if (definitions.length > 0) senses.push({ partOfSpeech, source, definitions });
    }
  }
  return {
    word: wiktionary?.word ?? wordNet?.word ?? word,
    senses,
  };
}

export async function searchDictionary(query: string): Promise<DictionaryResult[]> {
  const word = normalizeToken(query.trim());
  if (!word) return [];

  const lemmaDict = await loadLemmaDict();
  const index = lemmaDict[LEMMA_INFLECTION_INDEX];
  const evidence = index && Object.hasOwn(index.entries, word) ? index.entries[word] : undefined;
  const headwords = new Set([word, ...Object.keys(evidence?.lemmas ?? {})]);
  const curatedLemma = lemmaDict[word];
  if (curatedLemma) headwords.add(normalizeToken(curatedLemma));

  const [original, ...baseForms] = await Promise.all(Array.from(headwords, lookupHeadword));
  // The WordNet export includes inflection aliases that reuse the base form's synset IDs.
  const baseSynsetIds = new Set(baseForms.flatMap(({ wordNet }) =>
    (wordNet?.senses ?? []).flatMap((sense) => sense.definitions.map((definition) => definition.id)),
  ));
  const results = [
    groupDefinitions(original, baseSynsetIds),
    ...baseForms.map((entry) => {
      const result = groupDefinitions(entry, new Set<string>());
      const relationMask = evidence?.lemmas[entry.word] ?? 0;
      if (!relationMask || !index) return result;

      const preferredPartsOfSpeech = new Set(index.positions.filter(
        (_, position) => (relationMask & 2 ** position) !== 0,
      ));
      return {
        ...result,
        senses: [...result.senses].sort((left, right) =>
          Number(preferredPartsOfSpeech.has(right.partOfSpeech)) - Number(preferredPartsOfSpeech.has(left.partOfSpeech)),
        ),
      };
    }),
  ];
  return results.filter((result) => result.senses.length > 0);
}
