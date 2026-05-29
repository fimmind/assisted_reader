import type { ReaderSettings } from './types';

export const PROFILE_STORAGE_KEY = 'easeword-profiles-v1';
export const SETTINGS_STORAGE_KEY = 'easeword-settings-v1';
export const BOOKS_FALLBACK_STORAGE_KEY = 'easeword-books-fallback-v1';
export const BOOKS_DB_NAME = 'vocab_reader_books_v1';
export const BOOKS_STORE_NAME = 'books';
export const BOOKS_DB_VERSION = 1;

export const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
export const WORD_TOKEN_RE = /^[A-Za-z]+(?:['’][A-Za-z]+)?$/;
export const SENTENCE_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineSpacing: 'Normal',
  fontChoice: 'Serif',
  pageWidth: 'Normal',
  maxWordsPerParagraph: 2,
  knowledgeThreshold: 0.5,
  englishVariant: 'US',
};

export const DEFAULT_PROFILE_NAME = 'Default Reader';

export const CALENDAR_EXCLUSIONS = new Set<string>([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

export const TITLE_CASE_NOISE = new Set<string>([
  'the',
  'and',
  'this',
  'that',
  'these',
  'those',
  'it',
  'he',
  'she',
  'they',
  'we',
  'i',
  'you',
  'a',
  'an',
  'in',
  'on',
  'at',
  'of',
  'to',
  'for',
  'with',
  'as',
  'by',
  'from',
]);

export const JSZIP_CDN_URL = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
export const COMPROMISE_CDN_URL = 'https://unpkg.com/compromise@14.15.0/builds/compromise.min.js';

export const ADAPTIVE_TOP_K = 3;
export const ADAPTIVE_TEMPERATURE = 0.03;
