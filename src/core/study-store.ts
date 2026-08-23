import {
  DEFAULT_STUDY_WORD_COUNT,
  MAX_STUDY_WORD_COUNT,
  MIN_STUDY_WORD_COUNT,
  STUDY_STORAGE_KEY,
} from './constants';
import { createEmptyStudyState } from './study-session';
import type { StudyPersistenceState } from './study-session';
import type { AnkiTranscriptionLayout } from './study';

function isValidRequestedCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_STUDY_WORD_COUNT &&
    value <= MAX_STUDY_WORD_COUNT
  );
}

function isAnkiTranscriptionLayout(
  value: unknown,
): value is AnkiTranscriptionLayout {
  return value === 'separate' || value === 'merged';
}

function parseStudyState(value: unknown): StudyPersistenceState {
  if (!value || typeof value !== 'object') {
    throw new Error('Saved Study data is invalid: expected an object.');
  }
  const candidate = value as Partial<StudyPersistenceState>;
  if (candidate.schemaVersion !== 1) {
    throw new Error(
      `Saved Study data uses an unsupported schema version: ${String(candidate.schemaVersion)}`,
    );
  }
  if (
    !Array.isArray(candidate.observations) ||
    !Array.isArray(candidate.chapterProgress) ||
    !Array.isArray(candidate.sessions)
  ) {
    throw new Error(
      'Saved Study data is invalid: observations, chapter progress, or sessions are missing.',
    );
  }
  return {
    schemaVersion: 1,
    lastRequestedCount: isValidRequestedCount(candidate.lastRequestedCount)
      ? candidate.lastRequestedCount
      : DEFAULT_STUDY_WORD_COUNT,
    ankiTranscriptionLayout: isAnkiTranscriptionLayout(
      candidate.ankiTranscriptionLayout,
    )
      ? candidate.ankiTranscriptionLayout
      : 'separate',
    observations: candidate.observations,
    chapterProgress: candidate.chapterProgress,
    sessions: candidate.sessions,
  };
}

export function loadStudyState(): StudyPersistenceState {
  const raw = localStorage.getItem(STUDY_STORAGE_KEY);
  if (!raw) {
    return createEmptyStudyState(DEFAULT_STUDY_WORD_COUNT);
  }
  try {
    return parseStudyState(JSON.parse(raw) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load saved Study progress. ${message}`);
  }
}

export function saveStudyState(state: StudyPersistenceState): void {
  localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify(state));
}

export function clearStudyDataForProfile(profileId: string): void {
  const state = loadStudyState();
  saveStudyState({
    ...state,
    observations: state.observations.filter(
      (observation) => observation.profileId !== profileId,
    ),
    chapterProgress: state.chapterProgress.filter(
      (progress) => progress.profileId !== profileId,
    ),
    sessions: state.sessions.filter(
      (session) => session.profileId !== profileId,
    ),
  });
}
