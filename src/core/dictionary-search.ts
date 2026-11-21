import { loadLemmaDict } from './lemma';
import { loadDictionaryHeadwords } from './dictionary-headwords';
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

export interface DictionaryResult {
  word: string;
  senses: DictionarySenseGroup[];
}

interface DictionarySearchPage {
  entries: DictionaryResult[];
  nextOffset: number | null;
}

const SEARCH_PAGE_SIZE = 20;

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

export async function searchDictionary(query: string, offset: number): Promise<DictionarySearchPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid dictionary search offset: offset=${offset}`);
  }
  const word = normalizeToken(query.trim());
  if (!word) return { entries: [], nextOffset: null };

  const [lemmaDict, vocabulary] = await Promise.all([loadLemmaDict(), loadDictionaryHeadwords()]);
  const index = lemmaDict[LEMMA_INFLECTION_INDEX];
  const evidence = index && Object.hasOwn(index.entries, word) ? index.entries[word] : undefined;
  const headwords = new Set([word, ...Object.keys(evidence?.lemmas ?? {})]);
  const curatedLemma = lemmaDict[word];
  if (curatedLemma) headwords.add(normalizeToken(curatedLemma));

  const completions = vocabulary.filter((candidate) => candidate.startsWith(word) && !headwords.has(candidate));
  completions.sort((left, right) => left.length - right.length || left.localeCompare(right));
  const candidates = [...headwords, ...completions];
  const selectedWords = candidates.slice(offset, offset + SEARCH_PAGE_SIZE);
  const lookups = await Promise.all(selectedWords.map(lookupHeadword));
  const baseWords = new Set(lookups.flatMap((entry) =>
    Object.keys(index?.entries[entry.word]?.lemmas ?? {}).filter((lemma) => lemma !== entry.word),
  ));
  const relatedWords = [...baseWords].filter((lemma) => candidates.includes(lemma) && !selectedWords.includes(lemma));
  const relatedLookups = await Promise.all(relatedWords.map(lookupHeadword));
  const entriesByWord = new Map([...lookups, ...relatedLookups].map((entry) => [entry.word, entry]));
  // The WordNet export includes inflection aliases that reuse the base form's synset IDs.
  const results = lookups.map((entry) => {
    const baseSynsetIds = new Set(Object.keys(index?.entries[entry.word]?.lemmas ?? {})
      .filter((lemma) => lemma !== entry.word)
      .flatMap((lemma) => (entriesByWord.get(lemma)?.wordNet?.senses ?? [])
        .flatMap((sense) => sense.definitions.map((definition) => definition.id))));
    const result = groupDefinitions(entry, baseSynsetIds);
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
  });
  const nextOffset = offset + selectedWords.length;
  return {
    entries: results.filter((result) => result.senses.length > 0),
    nextOffset: nextOffset < candidates.length ? nextOffset : null,
  };
}
