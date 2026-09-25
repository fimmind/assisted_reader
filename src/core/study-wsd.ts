import type { LazyLexicon } from './lexicon';
import { splitSentenceSpans } from './nlp';
import type { StudyCardItem, StudyTextScope } from './study';
import type { LexiconEntry, ReaderSettings } from './types';
import { filterWordNetEntry, marginForReductionLevel, paragraphWindowForWsd, sentenceWindowForWsd, wordNetGlosses } from './wsd-filter';
import type { WsdContext } from './wsd-filter';
import { scoreWordSenses, waitForWsdModelReady } from './wsd-runtime';

export function studyWsdContext(
  item: StudyCardItem,
  scope: StudyTextScope,
  settings: ReaderSettings,
): WsdContext {
  const paragraphIndex = item.example.paragraphIndex - scope.paragraphOffset;
  const paragraph = scope.paragraphs[paragraphIndex];
  if (paragraph === undefined) {
    throw new RangeError(`Study WSD paragraph is outside the saved scope: word=${item.lemma} index=${item.example.paragraphIndex}`);
  }
  const sentence = splitSentenceSpans(paragraph)[item.example.sentenceIndex];
  const target = item.example.targetSpans[0];
  if (!sentence || sentence.text !== item.example.sentence || !target) {
    throw new RangeError(`Study WSD example does not match the saved scope: word=${item.lemma} sentence=${item.example.sentenceIndex}`);
  }
  if (target.start < 0 || target.end <= target.start || target.end > sentence.text.length) {
    throw new RangeError(`Invalid Study WSD target span: word=${item.lemma} start=${target.start} end=${target.end}`);
  }
  const context: WsdContext = {
    text: paragraph,
    start: sentence.start + target.start,
    end: sentence.start + target.end,
  };
  return settings.wsdContextUnit === 'sentence'
    ? sentenceWindowForWsd(scope.paragraphs, paragraphIndex, context, settings.wsdContextSize)
    : paragraphWindowForWsd(scope.paragraphs, paragraphIndex, context, settings.wsdContextSize);
}

export function studyItemWithWsdScores(
  item: StudyCardItem,
  entry: LexiconEntry,
  scores: number[],
  margin: number,
): StudyCardItem {
  const filtered = filterWordNetEntry(entry, scores, margin);
  const definitions = [...new Set(filtered.senses.flatMap((sense) => sense.definitions.map((definition) => definition.trim()).filter(Boolean)))];
  const definition = definitions[0];
  if (!definition) {
    throw new Error(`WSD left no Study definition: word=${item.lemma}`);
  }
  return { ...item, definition, definitions };
}

export async function resolveStudyWsdItem(
  item: StudyCardItem,
  scope: StudyTextScope,
  settings: ReaderSettings,
  lexicon: LazyLexicon,
  signal: AbortSignal,
): Promise<StudyCardItem> {
  if (!settings.wordSenseDisambiguationEnabled) {
    return item;
  }
  const rawEntry = await lexicon.lookup(item.lemma);
  if (!rawEntry) {
    throw new Error(`Study WSD dictionary entry is missing: word=${item.lemma}`);
  }
  const senses = item.partOfSpeech === null
    ? rawEntry.senses
    : rawEntry.senses.filter((sense) => sense.partOfSpeech === item.partOfSpeech);
  const entry = { ...rawEntry, senses };
  const glosses = wordNetGlosses(entry);
  if (glosses.length < 2) {
    return item;
  }
  const context = studyWsdContext(item, scope, settings);
  await waitForWsdModelReady(signal);
  const scores = await scoreWordSenses(context, glosses, 'visible-card', signal);
  return studyItemWithWsdScores(item, entry, scores, marginForReductionLevel(settings.wsdReductionLevel));
}
