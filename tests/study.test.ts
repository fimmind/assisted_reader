import test from "node:test";
import assert from "node:assert/strict";
import {
  answerCurrentCard,
  correctCurrentCardResponse,
  createCardSession,
  revealCurrentCard,
} from "../src/core/card-session.js";
import {
  calculateEstimatedCoverage,
  chooseStudyExample,
  createAnkiStudyText,
  createStudyExampleHtml,
  createStudyLexicalItemId,
  extractStudyCandidates,
  extractStudyCoverageItems,
  rankStudyCandidates,
  resolveStudyCandidate,
  selectStudyBatch,
} from "../src/core/study.js";
import type {
  StudyCandidate,
  StudyCardItem,
  StudyOccurrence,
  StudyTextScope,
} from "../src/core/study.js";
import {
  addSessionToStudyState,
  appendStudyBatch,
  completeStudySession,
  createEmptyStudyState,
  createImmediateReviewBatch,
  createStudyBatch,
  createStudySession,
  finalizeStudyCard,
  findUnfinishedStudySession,
  getActiveStudyBatch,
  getAttemptedChapterLexicalItemIds,
  getStudySessionFirstPassResults,
  undoLastStudyCard,
  updateActiveStudyCardSession,
} from "../src/core/study-session.js";
import type {
  StudyContextIdentity,
  StudyPersistenceState,
  StudySession,
} from "../src/core/study-session.js";
import type {
  ParagraphAnalysis,
  ParagraphToken,
  PartOfSpeech,
  UserProfile,
} from "../src/core/types.js";

const scope: StudyTextScope = {
  id: "book-1:chapter:0",
  sourceDocumentId: "book-1",
  chapterIndex: 0,
  paragraphs: ["He walked and kept walking. They record a record."],
  paragraphOffset: 0,
  unreadParagraphIndex: 0,
};

const context: StudyContextIdentity = {
  profileId: "profile-1",
  sourceDocumentId: "book-1",
  chapterIndex: 0,
};

function createProfile(observations: Record<string, 0 | 1>): UserProfile {
  return {
    id: "profile-1",
    name: "Reader",
    observations,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function createToken(
  paragraph: string,
  surfaceForm: string,
  occurrenceIndex: number,
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
  pKnown: number,
): ParagraphToken {
  let start = -1;
  let searchFrom = 0;
  for (let index = 0; index <= occurrenceIndex; index += 1) {
    start = paragraph.indexOf(surfaceForm, searchFrom);
    searchFrom = start + surfaceForm.length;
  }
  if (start < 0) {
    throw new Error(`Surface form not found in test paragraph: ${surfaceForm}`);
  }
  return {
    raw: surfaceForm,
    start,
    end: start + surfaceForm.length,
    lemma,
    pKnown,
    unknown: pKnown < 0.5,
    proper: false,
    partOfSpeech,
  };
}

function buildGroupingAnalysis(): ParagraphAnalysis[] {
  const paragraph = scope.paragraphs[0];
  return [
    {
      paragraphText: paragraph,
      cardTargets: [],
      tokens: [
        createToken(paragraph, "walked", 0, "walk", "verb", 0.3),
        createToken(paragraph, "walking", 0, "walk", "verb", 0.3),
        createToken(paragraph, "record", 0, "record", "verb", 0.4),
        createToken(paragraph, "record", 1, "record", "noun", 0.4),
      ],
    },
  ];
}

function createOccurrence(
  paragraphIndex: number,
  sentenceIndex: number,
  otherItemDifficulty: number,
  sentenceWordCount: number,
): StudyOccurrence {
  return {
    surfaceForm: "word",
    sentence: "A complete example sentence contains the word clearly.",
    paragraphIndex,
    sentenceIndex,
    start: 41,
    end: 45,
    targetSpans: [{ start: 41, end: 45 }],
    sentenceWordCount,
    otherItemDifficulty,
    completeSentence: true,
    upcoming: true,
    contextualPartOfSpeech: "noun",
  };
}

function createCandidate(
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
  pKnown: number,
  frequencyInScope: number,
  distinctParagraphCount: number,
  paragraphIndex: number,
): StudyCandidate {
  return {
    lexicalItemId: createStudyLexicalItemId(lemma, partOfSpeech),
    lemma,
    partOfSpeech,
    pKnown,
    frequencyInScope,
    distinctParagraphCount,
    occurrences: [createOccurrence(paragraphIndex, 0, 1, 9)],
  };
}

function createCardItem(
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
): StudyCardItem {
  const candidate = createCandidate(lemma, partOfSpeech, 0.3, 1, 1, 0);
  return {
    ...candidate,
    spelling: lemma,
    definition: `definition of ${lemma}`,
    definitions: [`definition of ${lemma}`],
    preferredTranscription: `/test/`,
    alternativeTranscriptions: [],
    example: {
      sentence: `A complete example sentence contains ${lemma} clearly.`,
      paragraphIndex: 0,
      sentenceIndex: 0,
      targetSpans: [{ start: 37, end: 37 + lemma.length }],
      occurrenceKey: "0:0",
    },
  };
}

function createSessionWithItems(items: StudyCardItem[]): {
  state: StudyPersistenceState;
  session: StudySession;
} {
  const session = createStudySession(
    context,
    scope,
    items.length,
    items,
    items,
    "2026-01-01T00:00:00.000Z",
    "session-1",
    "batch-1",
  );
  return {
    state: addSessionToStudyState(createEmptyStudyState(20), session, 20),
    session,
  };
}

function answerSessionCard(
  state: StudyPersistenceState,
  sessionId: string,
  initial: "known" | "unknown",
  correction: "known" | "unknown" | null,
): StudyPersistenceState {
  const session = state.sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  if (!session) {
    throw new Error("Test session missing.");
  }
  const batch = getActiveStudyBatch(session);
  let cardSession = answerCurrentCard(batch.cardSession, initial);
  if (correction !== null) {
    cardSession = correctCurrentCardResponse(cardSession, correction);
  }
  return updateActiveStudyCardSession(
    state,
    sessionId,
    cardSession,
    "2026-01-01T00:01:00.000Z",
  );
}

test("card reveal keeps responses empty until the learner answers", () => {
  const initial = createCardSession(["word"]);
  const revealed = revealCurrentCard(initial);

  assert.equal(revealed.items.word.revealed, true);
  assert.equal(revealed.items.word.initialResponse, null);
  assert.equal(revealed.items.word.finalResponse, null);

  const answered = answerCurrentCard(revealed, "known");
  assert.equal(answered.items.word.initialResponse, "known");
  assert.equal(answered.items.word.finalResponse, "known");
});

test("Study groups inflected surface forms by lemma and POS while retaining occurrences", () => {
  const candidates = extractStudyCandidates(
    scope,
    buildGroupingAnalysis(),
    createProfile({}),
  );
  const walk = candidates.find(
    (candidate) =>
      candidate.lexicalItemId === createStudyLexicalItemId("walk", "verb"),
  );
  assert.ok(walk);
  assert.equal(walk.frequencyInScope, 2);
  assert.deepEqual(
    walk.occurrences.map((occurrence) => occurrence.surfaceForm),
    ["walked", "walking"],
  );
  assert.equal(walk.occurrences[0].targetSpans.length, 2);
  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.lexicalItemId === createStudyLexicalItemId("record", "noun"),
    ),
  );
  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.lexicalItemId === createStudyLexicalItemId("record", "verb"),
    ),
  );
});

test("Study eligibility ceiling excludes high-probability items unless explicitly unknown", () => {
  const paragraph = "An obscure word appears here.";
  const analysis: ParagraphAnalysis[] = [
    {
      paragraphText: paragraph,
      cardTargets: [],
      tokens: [
        createToken(paragraph, "obscure", 0, "obscure", "adjective", 0.71),
      ],
    },
  ];
  assert.equal(
    extractStudyCandidates(
      { ...scope, paragraphs: [paragraph] },
      analysis,
      createProfile({}),
    ).length,
    0,
  );
  assert.equal(
    extractStudyCandidates(
      { ...scope, paragraphs: [paragraph] },
      analysis,
      createProfile({ obscure: 0 }),
    ).length,
    1,
  );
  assert.equal(
    extractStudyCandidates(
      { ...scope, paragraphs: [paragraph] },
      analysis,
      createProfile({ obscure: 1 }),
    ).length,
    0,
  );
});

test("coverage counts non-selectable tokens as known above the eligibility ceiling", () => {
  const paragraph = "Common vocabulary surrounds obscure vocabulary.";
  const analysis: ParagraphAnalysis[] = [
    {
      paragraphText: paragraph,
      cardTargets: [],
      tokens: [
        createToken(paragraph, "Common", 0, "common", "adjective", 0.95),
        createToken(paragraph, "vocabulary", 0, "vocabulary", "noun", 0.9),
        createToken(paragraph, "surrounds", 0, "surround", "verb", 0.85),
        createToken(paragraph, "obscure", 0, "obscure", "adjective", 0.2),
        createToken(paragraph, "vocabulary", 1, "vocabulary", "noun", 0.9),
      ],
    },
  ];
  const testScope = { ...scope, paragraphs: [paragraph] };
  const candidates = extractStudyCandidates(
    testScope,
    analysis,
    createProfile({}),
  );
  const coverageItems = extractStudyCoverageItems(testScope, analysis);

  assert.deepEqual(
    candidates.map((candidate) => candidate.lemma),
    ["obscure"],
  );
  assert.equal(
    coverageItems.reduce((total, item) => total + item.frequencyInScope, 0),
    5,
  );
  const coverage = calculateEstimatedCoverage(
    coverageItems,
    new Set([createStudyLexicalItemId("obscure", "adjective")]),
  );
  assert.ok(Math.abs(coverage.before - 0.84) < 1e-12);
  assert.equal(coverage.projectedAfter, 1);
});

test("Study ranking uses expected unfamiliar encounters and deterministic tie-breakers", () => {
  const highPriority = createCandidate("frequent", "noun", 0.5, 4, 1, 4);
  const lowPriority = createCandidate("rare", "noun", 0.1, 1, 1, 0);
  assert.equal(
    rankStudyCandidates([lowPriority, highPriority])[0].lemma,
    "frequent",
  );

  const paragraphWinner = createCandidate("spread", "noun", 0.5, 2, 2, 5);
  const probabilityWinner = createCandidate("uncertain", "noun", 0, 1, 1, 5);
  const earlyWinner = createCandidate("early", "noun", 0.5, 2, 1, 1);
  const lexicalLoser = createCandidate("zeta", "noun", 0.5, 2, 1, 1);
  const lexicalWinner = createCandidate("alpha", "noun", 0.5, 2, 1, 1);
  const ranked = rankStudyCandidates([
    lexicalLoser,
    earlyWinner,
    paragraphWinner,
    probabilityWinner,
    lexicalWinner,
  ]);
  assert.equal(ranked[0].lemma, "spread");
  assert.equal(ranked[1].lemma, "uncertain");
  assert.deepEqual(
    ranked.slice(2).map((candidate) => candidate.lemma),
    ["alpha", "early", "zeta"],
  );
});

test("context selection prefers moderate sentences with fewer other unknown words", () => {
  const candidate = createCandidate("word", "noun", 0.2, 2, 2, 0);
  candidate.occurrences = [
    createOccurrence(0, 0, 3.5, 12),
    createOccurrence(1, 0, 0.5, 12),
    createOccurrence(2, 0, 0.1, 40),
  ];
  const selected = chooseStudyExample(candidate, null);
  assert.equal(selected.paragraphIndex, 1);
});

test("Study resolves every available definition for the contextual lemma and POS", async () => {
  const candidate = createCandidate("record", "verb", 0.2, 1, 1, 0);
  const resolved = await resolveStudyCandidate(
    candidate,
    {
      lookup: async () => ({
        word: "record",
        senses: [
          {
            partOfSpeech: "noun",
            ipa: "/ˈrek.ɔːd/",
            definitions: ["a stored account"],
          },
          {
            partOfSpeech: "verb",
            ipa: "/rɪˈkɔːd/",
            definitions: ["to preserve information", "to capture sound"],
          },
        ],
      }),
    },
    "UK",
    null,
  );

  assert.deepEqual(resolved?.definitions, [
    "to preserve information",
    "to capture sound",
  ]);
  assert.equal(resolved?.definition, "to preserve information");
});

test("coverage treats selected item tokens as known", () => {
  const selected = createCandidate("selected", "noun", 0.2, 2, 1, 0);
  const other = createCandidate("other", "noun", 0.5, 2, 1, 0);
  const coverage = calculateEstimatedCoverage(
    [selected, other],
    new Set([selected.lexicalItemId]),
  );
  assert.equal(coverage.before, 0.35);
  assert.equal(coverage.projectedAfter, 0.75);
});

test("first-pass finalization retains initial and corrected final response and updates lemma Rasch once finalized", () => {
  const item = createCardItem("record", "noun");
  const setup = createSessionWithItems([item]);
  const answered = answerSessionCard(
    setup.state,
    setup.session.id,
    "unknown",
    "known",
  );
  assert.equal(createProfile({}).observations.record, undefined);
  const result = finalizeStudyCard(
    answered,
    createProfile({}),
    setup.session.id,
    "2026-01-01T00:02:00.000Z",
    "observation-1",
  );
  assert.equal(result.observation.initialResponse, "unknown");
  assert.equal(result.observation.finalResponse, "known");
  assert.equal(result.profile.observations.record, 1);
  assert.equal(
    getAttemptedChapterLexicalItemIds(result.studyState, context).has(
      item.lexicalItemId,
    ),
    true,
  );
});

test("first-pass correction from known to unknown uses only the final response", () => {
  const setup = createSessionWithItems([createCardItem("record", "verb")]);
  const answered = answerSessionCard(
    setup.state,
    setup.session.id,
    "known",
    "unknown",
  );
  const result = finalizeStudyCard(
    answered,
    createProfile({}),
    setup.session.id,
    "2026-01-01T00:02:00.000Z",
    "observation-2",
  );
  assert.equal(result.observation.initialResponse, "known");
  assert.equal(result.profile.observations.record, 0);
});

test("immediate review contains exactly preceding finalized unknown items and does not update Rasch", () => {
  const first = createCardItem("first", "noun");
  const second = createCardItem("second", "verb");
  let { state, session } = createSessionWithItems([first, second]);
  state = answerSessionCard(state, session.id, "unknown", null);
  let result = finalizeStudyCard(
    state,
    createProfile({}),
    session.id,
    "2026-01-01T00:02:00.000Z",
    "observation-first",
  );
  state = answerSessionCard(result.studyState, session.id, "known", null);
  result = finalizeStudyCard(
    state,
    result.profile,
    session.id,
    "2026-01-01T00:03:00.000Z",
    "observation-second",
  );
  session =
    result.studyState.sessions.find(
      (candidate) => candidate.id === session.id,
    ) ?? session;
  const review = createImmediateReviewBatch(session, "batch-1", "review-1");
  assert.deepEqual(
    review.items.map((item) => item.lemma),
    ["first"],
  );

  state = appendStudyBatch(
    result.studyState,
    session.id,
    review,
    "2026-01-01T00:04:00.000Z",
  );
  state = answerSessionCard(state, session.id, "known", null);
  const reviewed = finalizeStudyCard(
    state,
    result.profile,
    session.id,
    "2026-01-01T00:05:00.000Z",
    "review-observation",
  );
  assert.equal(reviewed.observation.source, "chapter-study-repeat");
  assert.deepEqual(reviewed.profile.observations, result.profile.observations);

  const reviewedSession = reviewed.studyState.sessions.find(
    (candidate) => candidate.id === session.id,
  );
  assert.ok(reviewedSession);
  assert.ok(review.firstPassBatchId);
  const repeatedReview = createImmediateReviewBatch(
    reviewedSession,
    review.firstPassBatchId,
    "review-2",
  );
  assert.deepEqual(
    repeatedReview.items.map((item) => item.lemma),
    ["first"],
  );
});

test("session results accumulate every first-pass batch and ignore review responses", () => {
  const first = createCardItem("first", "noun");
  const second = createCardItem("second", "verb");
  let { state, session } = createSessionWithItems([first]);
  state = answerSessionCard(state, session.id, "unknown", null);
  let result = finalizeStudyCard(
    state,
    createProfile({}),
    session.id,
    "2026-01-01T00:02:00.000Z",
    "first-observation",
  );
  state = appendStudyBatch(
    result.studyState,
    session.id,
    createStudyBatch("batch-2", "first-pass", null, [second]),
    "2026-01-01T00:03:00.000Z",
  );
  state = answerSessionCard(state, session.id, "known", null);
  result = finalizeStudyCard(
    state,
    result.profile,
    session.id,
    "2026-01-01T00:04:00.000Z",
    "second-observation",
  );
  session =
    result.studyState.sessions.find(
      (candidate) => candidate.id === session.id,
    ) ?? session;
  const review = createImmediateReviewBatch(session, "batch-1", "review-2");
  state = appendStudyBatch(
    result.studyState,
    session.id,
    review,
    "2026-01-01T00:05:00.000Z",
  );
  state = answerSessionCard(state, session.id, "known", null);
  const reviewed = finalizeStudyCard(
    state,
    result.profile,
    session.id,
    "2026-01-01T00:06:00.000Z",
    "review-observation-2",
  );
  session =
    reviewed.studyState.sessions.find(
      (candidate) => candidate.id === session.id,
    ) ?? session;
  const accumulated = getStudySessionFirstPassResults(session);

  assert.deepEqual(
    accumulated.wordsToLearn.map((item) => item.lemma),
    ["first"],
  );
  assert.deepEqual(
    accumulated.alreadyKnew.map((item) => item.lemma),
    ["second"],
  );
});

test("Undo restores prior Rasch observation, chapter state, history, and session position", () => {
  const item = createCardItem("restore", "verb");
  const setup = createSessionWithItems([item]);
  const answered = answerSessionCard(
    setup.state,
    setup.session.id,
    "unknown",
    null,
  );
  const finalized = finalizeStudyCard(
    answered,
    createProfile({ restore: 1 }),
    setup.session.id,
    "2026-01-01T00:02:00.000Z",
    "undo-observation",
  );
  const undone = undoLastStudyCard(
    finalized.studyState,
    finalized.profile,
    setup.session.id,
    "2026-01-01T00:03:00.000Z",
  );
  assert.equal(undone.profile.observations.restore, 1);
  assert.equal(undone.studyState.observations.length, 0);
  assert.equal(
    getAttemptedChapterLexicalItemIds(undone.studyState, context).has(
      item.lexicalItemId,
    ),
    false,
  );
  const restoredBatch = getActiveStudyBatch(undone.studyState.sessions[0]);
  assert.equal(restoredBatch.cardSession.currentPosition, 0);
  assert.equal(
    restoredBatch.cardSession.items[item.lexicalItemId].finalized,
    false,
  );
  assert.equal(
    restoredBatch.cardSession.items[item.lexicalItemId].initialResponse,
    null,
  );
  assert.equal(
    restoredBatch.cardSession.items[item.lexicalItemId].finalResponse,
    null,
  );
  assert.equal(
    restoredBatch.cardSession.items[item.lexicalItemId].revealed,
    false,
  );
});

test("Learn more selection excludes current-session presentations", () => {
  const presented = createCandidate("presented", "noun", 0.2, 3, 1, 0);
  const available = createCandidate("available", "noun", 0.2, 2, 1, 0);
  const selected = selectStudyBatch(
    [presented, available],
    new Set([presented.lexicalItemId]),
    20,
  );
  assert.deepEqual(
    selected.map((candidate) => candidate.lemma),
    ["available"],
  );
});

test("a new session does not inherit presentation exclusions from completed sessions", () => {
  const repeatedItem = createCardItem("repeated", "noun");
  const firstSetup = createSessionWithItems([repeatedItem]);
  const answered = answerSessionCard(
    firstSetup.state,
    firstSetup.session.id,
    "unknown",
    null,
  );
  const finalized = finalizeStudyCard(
    answered,
    createProfile({}),
    firstSetup.session.id,
    "2026-01-01T00:01:00.000Z",
    "prior-session-observation",
  );
  const completedState = completeStudySession(
    finalized.studyState,
    firstSetup.session.id,
    "2026-01-01T00:02:00.000Z",
  );
  assert.equal(
    getAttemptedChapterLexicalItemIds(completedState, context).has(
      repeatedItem.lexicalItemId,
    ),
    true,
  );

  const nextSession = createStudySession(
    context,
    scope,
    20,
    [repeatedItem],
    [repeatedItem],
    "2026-01-02T00:00:00.000Z",
    "session-2",
    "batch-2",
  );
  const selected = selectStudyBatch(
    [repeatedItem],
    new Set(nextSession.presentedLexicalItemIds),
    20,
  );
  assert.deepEqual(
    selected.map((candidate) => candidate.lexicalItemId),
    [repeatedItem.lexicalItemId],
  );
});

test("unfinished session restoration is scoped to profile, book, and chapter", () => {
  const setup = createSessionWithItems([createCardItem("scope", "noun")]);
  assert.equal(
    findUnfinishedStudySession(setup.state, context)?.id,
    setup.session.id,
  );
  assert.equal(
    findUnfinishedStudySession(setup.state, { ...context, profileId: "other" }),
    null,
  );
  assert.equal(
    findUnfinishedStudySession(setup.state, {
      ...context,
      sourceDocumentId: "other",
    }),
    null,
  );
  assert.equal(
    findUnfinishedStudySession(setup.state, { ...context, chapterIndex: 1 }),
    null,
  );
});

test("Anki text has exact headers, six one-line fields, normalized controls, and escaped marked context", () => {
  const item = createCardItem("withdrew", "verb");
  item.preferredTranscription = "";
  item.alternativeTranscriptions = ["/one\ttab/", "/two\nlines/"];
  item.definition = "to leave\r\na place\tquietly";
  item.example = {
    sentence: "He <withdrew> & withdrew.",
    paragraphIndex: 0,
    sentenceIndex: 0,
    targetSpans: [
      { start: 4, end: 12 },
      { start: 16, end: 24 },
    ],
    occurrenceKey: "0:0",
  };
  assert.equal(
    createStudyExampleHtml(item.example),
    "He &lt;<b>withdrew</b>&gt; &amp; <b>withdrew</b>.",
  );
  const output = createAnkiStudyText([item], "separate");
  const lines = output.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 2), ["#separator:tab", "#html:true"]);
  assert.equal(lines.length, 3);
  const fields = lines[2].split("\t");
  assert.equal(fields.length, 6);
  assert.equal(fields[2], "");
  assert.equal(fields[3], "one tab, two<br>lines");
  assert.equal(fields[4], "to leave a place quietly");

  const pronouncedItem = createCardItem("spoken", "adjective");
  pronouncedItem.preferredTranscription = "/ˈspəʊkən/";
  pronouncedItem.alternativeTranscriptions = ["/ˈspoʊkən/", "ˈspoʊ.kn̩"];
  const pronouncedFields = createAnkiStudyText([pronouncedItem], "separate")
    .trimEnd()
    .split("\n")[2]
    .split("\t");
  assert.equal(pronouncedFields[2], "ˈspəʊkən");
  assert.equal(pronouncedFields[3], "ˈspoʊkən, ˈspoʊ.kn̩");

  const mergedPronunciationFields = createAnkiStudyText(
    [pronouncedItem],
    "merged",
  )
    .trimEnd()
    .split("\n")[2]
    .split("\t");
  assert.equal(mergedPronunciationFields.length, 6);
  assert.equal(mergedPronunciationFields[2], "ˈspəʊkən, ˈspoʊkən, ˈspoʊ.kn̩");
  assert.equal(mergedPronunciationFields[3], "");
});
