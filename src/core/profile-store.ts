import { DEFAULT_PROFILE_NAME, DEFAULT_READER_SETTINGS, PROFILE_STORAGE_KEY, SETTINGS_STORAGE_KEY } from './constants';
import { createId } from './math';
import type { ProfileState, ReaderSettings, UserProfile } from './types';

const STATE_EVENT = 'easeword-state-updated';

function persistProfileStateWithoutEvent(state: ProfileState): void {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(state));
}

function persistReaderSettingsWithoutEvent(settings: ReaderSettings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function sanitizeNumeric(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function sanitizeKnowledgeThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_READER_SETTINGS.knowledgeThreshold;
  }

  // Legacy payloads sometimes stored threshold on a 0..100 scale.
  const normalized = value > 1 ? value / 100 : value;
  const clamped = sanitizeNumeric(
    normalized,
    DEFAULT_READER_SETTINGS.knowledgeThreshold,
    0.05,
    0.95,
  );

  // Current UI has no direct threshold control; keep default behavior stable.
  if (clamped <= 0.051) {
    return DEFAULT_READER_SETTINGS.knowledgeThreshold;
  }

  return clamped;
}

function sanitizeEnglishVariant(value: unknown): ReaderSettings['englishVariant'] {
  return value === 'UK' ? 'UK' : 'US';
}

function createDefaultProfile(): UserProfile {
  return {
    id: createId('profile'),
    name: DEFAULT_PROFILE_NAME,
    observations: {},
    createdAt: new Date().toISOString(),
  };
}

function ensureProfileState(rawState: ProfileState | null): ProfileState {
  if (!rawState || rawState.profiles.length === 0) {
    const profile = createDefaultProfile();
    return { activeProfileId: profile.id, profiles: [profile] };
  }

  const activeExists = rawState.profiles.some((profile) => profile.id === rawState.activeProfileId);
  if (!activeExists) {
    return { activeProfileId: rawState.profiles[0].id, profiles: rawState.profiles };
  }

  return rawState;
}

export function emitStateUpdated(): void {
  window.dispatchEvent(new CustomEvent(STATE_EVENT));
}

export function listenStateUpdated(callback: () => void): () => void {
  window.addEventListener(STATE_EVENT, callback);
  return () => window.removeEventListener(STATE_EVENT, callback);
}

export function loadProfileState(): ProfileState {
  const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (!raw) {
    const state = ensureProfileState(null);
    persistProfileStateWithoutEvent(state);
    return state;
  }

  try {
    const parsed = JSON.parse(raw) as ProfileState;
    const state = ensureProfileState(parsed);
    if (
      state.activeProfileId !== parsed.activeProfileId ||
      state.profiles.length !== parsed.profiles.length
    ) {
      persistProfileStateWithoutEvent(state);
    }
    return state;
  } catch (error) {
    console.warn('profile-state-parse-failed', { error });
    const state = ensureProfileState(null);
    persistProfileStateWithoutEvent(state);
    return state;
  }
}

export function saveProfileState(state: ProfileState): void {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(state));
  emitStateUpdated();
}

export function getActiveProfile(state: ProfileState): UserProfile {
  const profile = state.profiles.find((item) => item.id === state.activeProfileId);
  if (!profile) {
    throw new Error('Active profile is missing from profile state.');
  }
  return profile;
}

export function upsertObservation(word: string, known: boolean): void {
  const state = loadProfileState();
  const active = getActiveProfile(state);
  active.observations[word.toLowerCase()] = known ? 1 : 0;
  saveProfileState(state);
}

export function upsertObservationsBatch(observations: Record<string, 0 | 1>): void {
  const entries = Object.entries(observations);
  if (entries.length === 0) {
    return;
  }

  const state = loadProfileState();
  const active = getActiveProfile(state);
  for (const [word, label] of entries) {
    active.observations[word.toLowerCase()] = label;
  }
  saveProfileState(state);
}

export function createProfile(name: string): void {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new Error('Profile name cannot be empty.');
  }

  const state = loadProfileState();
  const profile: UserProfile = {
    id: createId('profile'),
    name: trimmedName,
    observations: {},
    createdAt: new Date().toISOString(),
  };
  state.profiles.push(profile);
  state.activeProfileId = profile.id;
  saveProfileState(state);
}

export function renameProfile(profileId: string, name: string): void {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new Error('Profile name cannot be empty.');
  }

  const state = loadProfileState();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`Cannot rename profile. Missing id=${profileId}`);
  }
  profile.name = trimmedName;
  saveProfileState(state);
}

export function setActiveProfile(profileId: string): void {
  const state = loadProfileState();
  const exists = state.profiles.some((profile) => profile.id === profileId);
  if (!exists) {
    throw new Error(`Cannot set active profile. Missing profile id=${profileId}`);
  }
  state.activeProfileId = profileId;
  saveProfileState(state);
}

export function deleteProfile(profileId: string): void {
  const state = loadProfileState();
  if (state.profiles.length <= 1) {
    throw new Error('At least one profile must exist.');
  }

  const nextProfiles = state.profiles.filter((profile) => profile.id !== profileId);
  if (nextProfiles.length === state.profiles.length) {
    throw new Error(`Cannot delete profile. Missing id=${profileId}`);
  }

  state.profiles = nextProfiles;
  if (state.activeProfileId === profileId) {
    state.activeProfileId = nextProfiles[0].id;
  }
  saveProfileState(state);
}

export function resetProfileObservations(profileId: string): void {
  const state = loadProfileState();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`Cannot reset profile. Missing id=${profileId}`);
  }
  profile.observations = {};
  saveProfileState(state);
}

export function loadReaderSettings(): ReaderSettings {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    persistReaderSettingsWithoutEvent(DEFAULT_READER_SETTINGS);
    return DEFAULT_READER_SETTINGS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    const settings: ReaderSettings = {
      fontSize: sanitizeNumeric(parsed.fontSize, DEFAULT_READER_SETTINGS.fontSize, 12, 32),
      lineSpacing: parsed.lineSpacing ?? DEFAULT_READER_SETTINGS.lineSpacing,
      fontChoice: parsed.fontChoice ?? DEFAULT_READER_SETTINGS.fontChoice,
      pageWidth: parsed.pageWidth ?? DEFAULT_READER_SETTINGS.pageWidth,
      maxWordsPerParagraph: sanitizeNumeric(parsed.maxWordsPerParagraph, DEFAULT_READER_SETTINGS.maxWordsPerParagraph, 1, 5),
      deduplicationRadius: sanitizeNumeric(parsed.deduplicationRadius, DEFAULT_READER_SETTINGS.deduplicationRadius, 0, 20),
      knowledgeThreshold: sanitizeKnowledgeThreshold(parsed.knowledgeThreshold),
      englishVariant: sanitizeEnglishVariant(parsed.englishVariant),
    };

    const serialized = JSON.stringify(settings);
    if (serialized !== raw) {
      persistReaderSettingsWithoutEvent(settings);
    }

    return settings;
  } catch (error) {
    console.warn('settings-parse-failed', { error });
    persistReaderSettingsWithoutEvent(DEFAULT_READER_SETTINGS);
    return DEFAULT_READER_SETTINGS;
  }
}

export function saveReaderSettings(settings: ReaderSettings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  emitStateUpdated();
}
