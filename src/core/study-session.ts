import {
  createCardSession,
  finalizeCurrentCard,
  getFinalizedResponses,
  isCardSessionComplete,
  resetCurrentCard,
} from './card-session';
import type { CardResponse, CardSessionState } from './card-session';
import { createId } from './math';
import { chooseStudyExample } from './study';
import type { StudyCardItem, StudyCoverageItem, StudyTextScope } from './study';
import type { PartOfSpeech, UserProfile } from './types';

export type StudyObservationSource = 'chapter-study' | 'chapter-study-repeat';
export type StudySessionStatus = 'active' | 'completed';
export type StudyBatchKind = 'first-pass' | 'immediate-review';

export interface StudyObservation {
  id: string;
  profileId: string;
  lexicalItemId: string;
  lemma: string;
  partOfSpeech: PartOfSpeech | null;
  initialResponse: CardResponse;
  finalResponse: CardResponse;
  timestamp: string;
  source: StudyObservationSource;
  sourceDocumentId: string;
  textScopeId: string;
  chapterIndex: number;
  studySessionId: string;
  studyBatchId: string;
}

export interface ChapterStudyItemState {
  lexicalItemId: string;
  firstAttemptedAt: string;
  lastAttemptedAt: string;
  lastFinalResponse: CardResponse;
  unknownResponseCount: number;
}

export interface ChapterStudyProgress {
  profileId: string;
  sourceDocumentId: string;
  chapterIndex: number;
  items: Record<string, ChapterStudyItemState>;
}

export interface StudyBatch {
  id: string;
  kind: StudyBatchKind;
  firstPassBatchId: string | null;
  items: StudyCardItem[];
  cardSession: CardSessionState;
  completedAt: string | null;
}

interface PriorRaschObservation {
  existed: boolean;
  value: 0 | 1 | null;
}

interface StudyUndoSnapshot {
  observationId: string;
  batchId: string;
  previousCardSession: CardSessionState;
  previousBatchCompletedAt: string | null;
  previousPresentedLexicalItemIds: string[];
  previousChapterItemState: ChapterStudyItemState | null;
  priorRaschObservation: PriorRaschObservation;
  lemma: string;
  updatedRasch: boolean;
}

export interface StudySession {
  id: string;
  profileId: string;
  sourceDocumentId: string;
  chapterIndex: number;
  textScope: StudyTextScope;
  requestedCount: number;
  coverageItems: StudyCoverageItem[];
  status: StudySessionStatus;
  presentedLexicalItemIds: string[];
  batches: StudyBatch[];
  activeBatchId: string;
  lastUndo: StudyUndoSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudyPersistenceState {
  schemaVersion: 1;
  lastRequestedCount: number;
  observations: StudyObservation[];
  chapterProgress: ChapterStudyProgress[];
  sessions: StudySession[];
}

export interface StudyContextIdentity {
  profileId: string;
  sourceDocumentId: string;
  chapterIndex: number;
}

export interface StudyFinalizationResult {
  studyState: StudyPersistenceState;
  profile: UserProfile;
  observation: StudyObservation;
}

export interface StudyUndoResult {
  studyState: StudyPersistenceState;
  profile: UserProfile;
}

export interface StudySessionFirstPassResults {
  wordsToLearn: StudyCardItem[];
  alreadyKnew: StudyCardItem[];
}

export function createEmptyStudyState(
  lastRequestedCount: number,
): StudyPersistenceState {
  return {
    schemaVersion: 1,
    lastRequestedCount,
    observations: [],
    chapterProgress: [],
    sessions: [],
  };
}

export function isSameStudyContext(
  context: StudyContextIdentity,
  candidate: StudyContextIdentity,
): boolean {
  return (
    context.profileId === candidate.profileId &&
    context.sourceDocumentId === candidate.sourceDocumentId &&
    context.chapterIndex === candidate.chapterIndex
  );
}

export function findUnfinishedStudySession(
  state: StudyPersistenceState,
  context: StudyContextIdentity,
): StudySession | null {
  const sessions = state.sessions.filter(
    (session) =>
      session.status === 'active' && isSameStudyContext(context, session),
  );
  return (
    sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0] ?? null
  );
}

export function findChapterStudyProgress(
  state: StudyPersistenceState,
  context: StudyContextIdentity,
): ChapterStudyProgress | null {
  return (
    state.chapterProgress.find((progress) =>
      isSameStudyContext(context, progress),
    ) ?? null
  );
}

export function getAttemptedChapterLexicalItemIds(
  state: StudyPersistenceState,
  context: StudyContextIdentity,
): Set<string> {
  const progress = findChapterStudyProgress(state, context);
  return new Set(progress ? Object.keys(progress.items) : []);
}

export function createStudyBatch(
  id: string,
  kind: StudyBatchKind,
  firstPassBatchId: string | null,
  items: StudyCardItem[],
): StudyBatch {
  if (items.length === 0) {
    throw new RangeError('Cannot create an empty Study batch.');
  }
  return {
    id,
    kind,
    firstPassBatchId,
    items: items.map((item) => ({ ...item })),
    cardSession: createCardSession(items.map((item) => item.lexicalItemId)),
    completedAt: null,
  };
}

export function createStudySession(
  context: StudyContextIdentity,
  scope: StudyTextScope,
  requestedCount: number,
  items: StudyCardItem[],
  coverageItems: StudyCoverageItem[],
  timestamp: string,
  sessionId: string,
  batchId: string,
): StudySession {
  const batch = createStudyBatch(batchId, 'first-pass', null, items);
  return {
    id: sessionId,
    profileId: context.profileId,
    sourceDocumentId: context.sourceDocumentId,
    chapterIndex: context.chapterIndex,
    textScope: { ...scope, paragraphs: [...scope.paragraphs] },
    requestedCount,
    coverageItems: coverageItems.map((item) => ({ ...item })),
    status: 'active',
    presentedLexicalItemIds: [],
    batches: [batch],
    activeBatchId: batch.id,
    lastUndo: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function addSessionToStudyState(
  state: StudyPersistenceState,
  session: StudySession,
  requestedCount: number,
): StudyPersistenceState {
  const withoutSameSession = state.sessions.filter(
    (candidate) => candidate.id !== session.id,
  );
  return {
    ...state,
    lastRequestedCount: requestedCount,
    sessions: [...withoutSameSession, session],
  };
}

export function discardStudySession(
  state: StudyPersistenceState,
  sessionId: string,
): StudyPersistenceState {
  return {
    ...state,
    sessions: state.sessions.filter((session) => session.id !== sessionId),
  };
}

function getSession(
  state: StudyPersistenceState,
  sessionId: string,
): StudySession {
  const session = state.sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  if (!session) {
    throw new Error(`Study session not found: sessionId=${sessionId}`);
  }
  return session;
}

export function getActiveStudyBatch(session: StudySession): StudyBatch {
  const batch = session.batches.find(
    (candidate) => candidate.id === session.activeBatchId,
  );
  if (!batch) {
    throw new Error(
      `Active Study batch not found: sessionId=${session.id} batchId=${session.activeBatchId}`,
    );
  }
  return batch;
}

export function getStudySessionFirstPassResults(
  session: StudySession,
): StudySessionFirstPassResults {
  const wordsToLearn: StudyCardItem[] = [];
  const alreadyKnew: StudyCardItem[] = [];

  for (const batch of session.batches) {
    if (
      batch.kind !== 'first-pass' ||
      !isCardSessionComplete(batch.cardSession)
    ) {
      continue;
    }
    const responses = getFinalizedResponses(batch.cardSession);
    for (const item of batch.items) {
      const response = responses[item.lexicalItemId];
      if (response === 'unknown') {
        wordsToLearn.push(item);
      } else if (response === 'known') {
        alreadyKnew.push(item);
      }
    }
  }

  return { wordsToLearn, alreadyKnew };
}

function getCurrentCardItem(batch: StudyBatch): StudyCardItem {
  const lexicalItemId =
    batch.cardSession.orderedItemIds[batch.cardSession.currentPosition];
  const item = batch.items.find(
    (candidate) => candidate.lexicalItemId === lexicalItemId,
  );
  if (!item) {
    throw new Error(
      `Current Study item not found: batchId=${batch.id} position=${batch.cardSession.currentPosition}`,
    );
  }
  return item;
}

function replaceSession(
  state: StudyPersistenceState,
  nextSession: StudySession,
): StudyPersistenceState {
  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === nextSession.id ? nextSession : session,
    ),
  };
}

function updateChapterProgress(
  state: StudyPersistenceState,
  session: StudySession,
  item: StudyCardItem,
  response: CardResponse,
  timestamp: string,
): { state: StudyPersistenceState; previous: ChapterStudyItemState | null } {
  const context: StudyContextIdentity = session;
  const existing = findChapterStudyProgress(state, context);
  const previous = existing?.items[item.lexicalItemId] ?? null;
  const nextItem: ChapterStudyItemState = {
    lexicalItemId: item.lexicalItemId,
    firstAttemptedAt: previous?.firstAttemptedAt ?? timestamp,
    lastAttemptedAt: timestamp,
    lastFinalResponse: response,
    unknownResponseCount:
      (previous?.unknownResponseCount ?? 0) + (response === 'unknown' ? 1 : 0),
  };
  const nextProgress: ChapterStudyProgress = {
    profileId: session.profileId,
    sourceDocumentId: session.sourceDocumentId,
    chapterIndex: session.chapterIndex,
    items: { ...(existing?.items ?? {}), [item.lexicalItemId]: nextItem },
  };
  const chapterProgress = existing
    ? state.chapterProgress.map((progress) =>
        progress === existing ? nextProgress : progress,
      )
    : [...state.chapterProgress, nextProgress];
  return { state: { ...state, chapterProgress }, previous };
}

function createObservation(
  session: StudySession,
  batch: StudyBatch,
  item: StudyCardItem,
  initialResponse: CardResponse,
  finalResponse: CardResponse,
  timestamp: string,
  observationId: string,
): StudyObservation {
  return {
    id: observationId,
    profileId: session.profileId,
    lexicalItemId: item.lexicalItemId,
    lemma: item.lemma,
    partOfSpeech: item.partOfSpeech,
    initialResponse,
    finalResponse,
    timestamp,
    source:
      batch.kind === 'first-pass' ? 'chapter-study' : 'chapter-study-repeat',
    sourceDocumentId: session.sourceDocumentId,
    textScopeId: session.textScope.id,
    chapterIndex: session.chapterIndex,
    studySessionId: session.id,
    studyBatchId: batch.id,
  };
}

export function finalizeStudyCard(
  state: StudyPersistenceState,
  profile: UserProfile,
  sessionId: string,
  timestamp: string,
  observationId: string,
): StudyFinalizationResult {
  const session = getSession(state, sessionId);
  if (session.profileId !== profile.id) {
    throw new Error(
      `Cannot finalize Study card for another profile: sessionProfileId=${session.profileId} activeProfileId=${profile.id}`,
    );
  }
  const batch = getActiveStudyBatch(session);
  const item = getCurrentCardItem(batch);
  const interaction = batch.cardSession.items[item.lexicalItemId];
  if (
    !interaction ||
    interaction.initialResponse === null ||
    interaction.finalResponse === null
  ) {
    throw new Error(
      `Cannot finalize incomplete Study response: lexicalItemId=${item.lexicalItemId}`,
    );
  }

  const previousCardSession = batch.cardSession;
  const finalizedCardSession = finalizeCurrentCard(batch.cardSession);
  const nextBatch: StudyBatch = {
    ...batch,
    cardSession: finalizedCardSession,
    completedAt: isCardSessionComplete(finalizedCardSession) ? timestamp : null,
  };
  const observation = createObservation(
    session,
    batch,
    item,
    interaction.initialResponse,
    interaction.finalResponse,
    timestamp,
    observationId,
  );

  let nextState: StudyPersistenceState = {
    ...state,
    observations: [...state.observations, observation],
  };
  let nextProfile: UserProfile = {
    ...profile,
    observations: { ...profile.observations },
  };
  let previousChapterItemState: ChapterStudyItemState | null = null;
  const priorValue = profile.observations[item.lemma];
  const priorRaschObservation: PriorRaschObservation = {
    existed: priorValue === 0 || priorValue === 1,
    value: priorValue ?? null,
  };

  if (batch.kind === 'first-pass') {
    const chapterUpdate = updateChapterProgress(
      nextState,
      session,
      item,
      interaction.finalResponse,
      timestamp,
    );
    nextState = chapterUpdate.state;
    previousChapterItemState = chapterUpdate.previous;

    // Study identities are POS-specific, but the existing Rasch learner remains lemma-level.
    // Only the finalized first-pass response is submitted through that existing observation map.
    nextProfile.observations[item.lemma] =
      interaction.finalResponse === 'known' ? 1 : 0;
  }

  const previouslyPresented = session.presentedLexicalItemIds;
  const nextPresented =
    batch.kind === 'first-pass' &&
    !previouslyPresented.includes(item.lexicalItemId)
      ? [...previouslyPresented, item.lexicalItemId]
      : [...previouslyPresented];
  const nextSession: StudySession = {
    ...session,
    presentedLexicalItemIds: nextPresented,
    batches: session.batches.map((candidate) =>
      candidate.id === batch.id ? nextBatch : candidate,
    ),
    lastUndo: {
      observationId,
      batchId: batch.id,
      previousCardSession,
      previousBatchCompletedAt: batch.completedAt,
      previousPresentedLexicalItemIds: [...previouslyPresented],
      previousChapterItemState,
      priorRaschObservation,
      lemma: item.lemma,
      updatedRasch: batch.kind === 'first-pass',
    },
    updatedAt: timestamp,
  };
  nextState = replaceSession(nextState, nextSession);
  return { studyState: nextState, profile: nextProfile, observation };
}

function restoreChapterItem(
  state: StudyPersistenceState,
  session: StudySession,
  lexicalItemId: string,
  previous: ChapterStudyItemState | null,
): StudyPersistenceState {
  const progress = findChapterStudyProgress(state, session);
  if (!progress) {
    if (previous === null) {
      return state;
    }
    throw new Error(
      `Cannot restore missing chapter Study progress: sessionId=${session.id}`,
    );
  }
  const items = { ...progress.items };
  if (previous === null) {
    delete items[lexicalItemId];
  } else {
    items[lexicalItemId] = previous;
  }
  const nextProgress: ChapterStudyProgress = { ...progress, items };
  return {
    ...state,
    chapterProgress: state.chapterProgress.map((candidate) =>
      candidate === progress ? nextProgress : candidate,
    ),
  };
}

export function undoLastStudyCard(
  state: StudyPersistenceState,
  profile: UserProfile,
  sessionId: string,
  timestamp: string,
): StudyUndoResult {
  const session = getSession(state, sessionId);
  const snapshot = session.lastUndo;
  if (!snapshot) {
    throw new Error(
      `No finalized Study card is available to undo: sessionId=${sessionId}`,
    );
  }
  if (session.profileId !== profile.id) {
    throw new Error(
      `Cannot undo Study card for another profile: sessionProfileId=${session.profileId} activeProfileId=${profile.id}`,
    );
  }
  const batch = session.batches.find(
    (candidate) => candidate.id === snapshot.batchId,
  );
  if (!batch) {
    throw new Error(
      `Cannot undo missing Study batch: batchId=${snapshot.batchId}`,
    );
  }
  const lexicalItemId =
    snapshot.previousCardSession.orderedItemIds[
      snapshot.previousCardSession.currentPosition
    ];
  if (!lexicalItemId) {
    throw new Error(`Cannot resolve Study item for undo: batchId=${batch.id}`);
  }

  let nextState: StudyPersistenceState = {
    ...state,
    observations: state.observations.filter(
      (observation) => observation.id !== snapshot.observationId,
    ),
  };
  if (snapshot.updatedRasch) {
    nextState = restoreChapterItem(
      nextState,
      session,
      lexicalItemId,
      snapshot.previousChapterItemState,
    );
  }
  const nextBatch: StudyBatch = {
    ...batch,
    cardSession: resetCurrentCard(snapshot.previousCardSession),
    completedAt: snapshot.previousBatchCompletedAt,
  };
  const nextSession: StudySession = {
    ...session,
    status: 'active',
    activeBatchId: batch.id,
    presentedLexicalItemIds: snapshot.previousPresentedLexicalItemIds,
    batches: session.batches.map((candidate) =>
      candidate.id === batch.id ? nextBatch : candidate,
    ),
    lastUndo: null,
    updatedAt: timestamp,
  };
  nextState = replaceSession(nextState, nextSession);

  const observations = { ...profile.observations };
  if (snapshot.updatedRasch) {
    if (
      snapshot.priorRaschObservation.existed &&
      snapshot.priorRaschObservation.value !== null
    ) {
      observations[snapshot.lemma] = snapshot.priorRaschObservation.value;
    } else {
      delete observations[snapshot.lemma];
    }
  }
  return { studyState: nextState, profile: { ...profile, observations } };
}

export function createImmediateReviewBatch(
  session: StudySession,
  firstPassBatchId: string,
  batchId: string,
): StudyBatch {
  const sourceBatch = session.batches.find(
    (batch) => batch.id === firstPassBatchId && batch.kind === 'first-pass',
  );
  if (!sourceBatch || !isCardSessionComplete(sourceBatch.cardSession)) {
    throw new Error(
      `Cannot review an incomplete or missing first-pass batch: batchId=${firstPassBatchId}`,
    );
  }
  const responses = getFinalizedResponses(sourceBatch.cardSession);
  const missed = sourceBatch.items.filter(
    (item) => responses[item.lexicalItemId] === 'unknown',
  );
  if (missed.length === 0) {
    throw new RangeError(
      `First-pass batch has no missed items: batchId=${firstPassBatchId}`,
    );
  }
  const shuffled =
    missed.length > 1 ? [...missed.slice(1), missed[0]] : [...missed];
  const reviewItems = shuffled.map((item) => ({
    ...item,
    example: chooseStudyExample(item, item.example.occurrenceKey),
  }));
  return createStudyBatch(
    batchId,
    'immediate-review',
    firstPassBatchId,
    reviewItems,
  );
}

export function appendStudyBatch(
  state: StudyPersistenceState,
  sessionId: string,
  batch: StudyBatch,
  timestamp: string,
): StudyPersistenceState {
  const session = getSession(state, sessionId);
  if (session.batches.some((candidate) => candidate.id === batch.id)) {
    throw new Error(`Study batch already exists: batchId=${batch.id}`);
  }
  return replaceSession(state, {
    ...session,
    batches: [...session.batches, batch],
    activeBatchId: batch.id,
    lastUndo: null,
    updatedAt: timestamp,
  });
}

export function updateActiveStudyCardSession(
  state: StudyPersistenceState,
  sessionId: string,
  cardSession: CardSessionState,
  timestamp: string,
): StudyPersistenceState {
  const session = getSession(state, sessionId);
  const activeBatch = getActiveStudyBatch(session);
  const nextBatch: StudyBatch = { ...activeBatch, cardSession };
  return replaceSession(state, {
    ...session,
    batches: session.batches.map((batch) =>
      batch.id === activeBatch.id ? nextBatch : batch,
    ),
    updatedAt: timestamp,
  });
}

export function completeStudySession(
  state: StudyPersistenceState,
  sessionId: string,
  timestamp: string,
): StudyPersistenceState {
  const session = getSession(state, sessionId);
  return replaceSession(state, {
    ...session,
    status: 'completed',
    lastUndo: null,
    updatedAt: timestamp,
  });
}

export function createGeneratedStudySession(
  context: StudyContextIdentity,
  scope: StudyTextScope,
  requestedCount: number,
  items: StudyCardItem[],
  coverageItems: StudyCoverageItem[],
  timestamp: string,
): StudySession {
  return createStudySession(
    context,
    scope,
    requestedCount,
    items,
    coverageItems,
    timestamp,
    createId('study-session'),
    createId('study-batch'),
  );
}
