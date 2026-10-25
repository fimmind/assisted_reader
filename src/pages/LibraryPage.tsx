import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'wouter';
import { Moon, Sun, Settings, Upload, GraduationCap } from 'lucide-react';
import { useTheme } from '../components/ThemeProvider';
import { Button } from '../components/ui/button';
import { BookCard } from '../components/BookCard';
import { VocabularyTestOnboarding, VocabularyTestReminder } from '../components/VocabularyTestOnboarding';
import { importBookFromFile } from '@/core/book-parser';
import { deleteBookById, getBookById, listBooks, seedBooksIfEmpty, upsertBook } from '@/core/books-store';
import { createSeedBook } from '@/core/seed-book';
import { buildResumableBookLemmaHistogramAsync, calculateBookStatsFromLemmaHistogram } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, loadReaderSettings } from '@/core/profile-store';
import { loadVocabularyModel } from '@/core/model';
import { withBookReadingProgress } from '@/core/reading-progress-store';
import { bookProgressAtLocation, readerLocationFromLegacyProgress } from '@/core/reader-location';
import { loadLemmaDict } from '@/core/lemma';
import { LEXICAL_ANALYSIS_VERSION } from '@/core/nlp';
import { loadCompromise } from '@/core/external';
import { getCachedBookLemmaHistogram } from '@/core/book-lemma-histogram-cache';
import {
  clearTaggedBookChapterCheckpoints,
  completeBookLemmaHistogram,
  loadBookLemmaHistogramCheckpoints,
  loadCompletedBookLemmaHistogram,
  saveBookLemmaHistogramCheckpoint,
} from '@/core/book-lemma-histogram-checkpoint';
import { loadBundledBookLemmaHistogram } from '@/core/bundled-book-lemma-histogram';
import type { BookStats, ImportedBook } from '@/core/types';

type DeferredHandle = {
  kind: 'idle' | 'timeout';
  id: number;
};

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

interface CachedBookStatsEntry {
  stats: BookStats;
  observationFingerprint: string;
  bookUpdatedAt: string;
  knowledgeThreshold: number;
}

type CachedBookStatsMap = Record<string, CachedBookStatsEntry>;

const BOOK_STATS_CACHE_KEY = `easeword-book-stats-cache-v2-lexical-${LEXICAL_ANALYSIS_VERSION}`;

function statsCacheKey(profileId: string, bookId: string): string {
  return JSON.stringify([profileId, bookId]);
}

function clearDeferredHandle(handle: DeferredHandle | null): void {
  if (!handle) {
    return;
  }
  const idleWindow = window as IdleWindow;
  if (handle.kind === 'idle' && typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(handle.id);
    return;
  }
  window.clearTimeout(handle.id);
}

function scheduleDeferredTask(task: () => void, timeoutMs: number): DeferredHandle {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(task, { timeout: timeoutMs });
    return { kind: 'idle', id };
  }
  const id = window.setTimeout(task, timeoutMs);
  return { kind: 'timeout', id };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    // Animation frames can pause in background tabs; yield without waiting for a paint.
    window.setTimeout(resolve, 0);
  });
}

function calculateProgressPercent(book: ImportedBook): number {
  const location = book.location ?? readerLocationFromLegacyProgress(
    book,
    book.currentChapter,
    book.currentChapterProgress,
  );
  return bookProgressAtLocation(book, location) * 100;
}

function hashTokenSegment(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function computeObservationFingerprint(observations: Record<string, 0 | 1>): string {
  const keys = Object.keys(observations).sort();
  let hash = 2166136261;
  for (const key of keys) {
    hash = hashTokenSegment(key, hash);
    hash = hashTokenSegment(String(observations[key]), hash);
  }
  return `${keys.length}:${hash >>> 0}`;
}

function isValidCachedBookStatsMap(value: unknown): value is CachedBookStatsMap {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entries = Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const typed = entry as Partial<CachedBookStatsEntry>;
    if (!typed.stats || typeof typed.stats !== 'object') {
      return false;
    }
    if (typeof typed.observationFingerprint !== 'string') {
      return false;
    }
    if (typeof typed.bookUpdatedAt !== 'string') {
      return false;
    }
    if (typeof typed.knowledgeThreshold !== 'number' || !Number.isFinite(typed.knowledgeThreshold)) {
      return false;
    }
    if (
      typeof typed.stats.unknownTokenCount !== 'number'
      || typeof typed.stats.unknownTokenPercent !== 'number'
      || typeof typed.stats.progressPercent !== 'number'
    ) {
      return false;
    }
  }
  return true;
}

function loadCachedBookStatsMap(): CachedBookStatsMap {
  const raw = localStorage.getItem(BOOK_STATS_CACHE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidCachedBookStatsMap(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    console.warn('library-book-stats-cache-parse-failed', { error });
    return {};
  }
}

function saveCachedBookStatsMap(cacheMap: CachedBookStatsMap): void {
  localStorage.setItem(BOOK_STATS_CACHE_KEY, JSON.stringify(cacheMap));
}

export default function LibraryPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const [quizOpen, setQuizOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [books, setBooks] = useState<ImportedBook[]>([]);
  const [statsByBookId, setStatsByBookId] = useState<Record<string, BookStats>>({});
  const [analyzingBookProgressById, setAnalyzingBookProgressById] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const refreshRunIdRef = useRef(0);
  const fastStatsHandleRef = useRef<DeferredHandle | null>(null);
  const seedHandleRef = useRef<DeferredHandle | null>(null);
  const hasLoadedOnceRef = useRef(false);

  const stopBackgroundAnalysis = (): void => {
    refreshRunIdRef.current += 1;
    clearDeferredHandle(fastStatsHandleRef.current);
    fastStatsHandleRef.current = null;
    clearDeferredHandle(seedHandleRef.current);
    seedHandleRef.current = null;
  };

  const fallbackStats: BookStats = useMemo(() => ({
    unknownTokenCount: 0,
    unknownTokenPercent: 0,
    progressPercent: 0,
  }), []);

  const calculateBookStats = async (
    book: ImportedBook,
    model: Awaited<ReturnType<typeof loadVocabularyModel>>,
    runId: number,
    activeProfile: ReturnType<typeof getActiveProfile>,
    settings: ReturnType<typeof loadReaderSettings>,
    onProgress: (percent: number) => void,
  ): Promise<BookStats | null> => {
    const chapterCount = book.chapters.length;
    const progressPercent = calculateProgressPercent(book);
    if (chapterCount === 0) {
      return {
        ...fallbackStats,
        progressPercent,
      };
    }
    try {
      const analysisModelKey = `${model.modelKey}:lexical-analysis-${LEXICAL_ANALYSIS_VERSION}`;
      const cachedHistogram = getCachedBookLemmaHistogram(book.id, book.createdAt, book.updatedAt, analysisModelKey)
        ?? await loadCompletedBookLemmaHistogram(book.id, book.createdAt, analysisModelKey);
      if (cachedHistogram) {
        const cachedStats = calculateBookStatsFromLemmaHistogram(cachedHistogram, settings, model, activeProfile);
        return {
          ...cachedStats,
          progressPercent,
        };
      }

      const bundledHistogram = await loadBundledBookLemmaHistogram(book.id);
      if (bundledHistogram) {
        await completeBookLemmaHistogram(book.id, book.createdAt, analysisModelKey, bundledHistogram);
        const bundledStats = calculateBookStatsFromLemmaHistogram(bundledHistogram, settings, model, activeProfile);
        return {
          ...bundledStats,
          progressPercent,
        };
      }

      const [lemmaDict, nlp] = await Promise.all([loadLemmaDict(), loadCompromise()]);
      if (refreshRunIdRef.current !== runId) return null;
      let lastReportedPercent = -1;
      onProgress(0);
      const savedSegments = await loadBookLemmaHistogramCheckpoints(book.id, book.createdAt, analysisModelKey);
      const histogram = await buildResumableBookLemmaHistogramAsync(
        book,
        model,
        lemmaDict,
        nlp,
        savedSegments,
        {
          shouldContinue: () => refreshRunIdRef.current === runId,
          onWorkUnitProcessed: (processedUnits, totalUnits) => {
            if (totalUnits <= 0) {
              return;
            }
            const percent = Math.round((processedUnits / totalUnits) * 100);
            if (percent !== lastReportedPercent) {
              onProgress(percent);
              lastReportedPercent = percent;
            }
          },
          onYield: yieldToEventLoop,
          saveSegment: (segment) => saveBookLemmaHistogramCheckpoint(book.id, book.createdAt, analysisModelKey, segment),
          clearTaggedChapter: (chapterIndex) => clearTaggedBookChapterCheckpoints(book.id, chapterIndex),
        },
      );
      if (histogram === null) {
        return null;
      }
      await completeBookLemmaHistogram(book.id, book.createdAt, analysisModelKey, histogram);
      const stats = calculateBookStatsFromLemmaHistogram(histogram, settings, model, activeProfile);
      return {
        ...stats,
        progressPercent,
      };
    } catch (error) {
      throw new Error(`Book statistics could not be calculated: bookId=${book.id}`, { cause: error });
    }
  };

  const refreshBooksAndStats = async () => {
    const runId = refreshRunIdRef.current + 1;
    refreshRunIdRef.current = runId;
    setAnalyzingBookProgressById({});
    clearDeferredHandle(fastStatsHandleRef.current);
    fastStatsHandleRef.current = null;
    clearDeferredHandle(seedHandleRef.current);
    seedHandleRef.current = null;
    if (!hasLoadedOnceRef.current) {
      setIsLoading(true);
    }

    try {
      let loadedBooks = await listBooks();
      if (refreshRunIdRef.current !== runId) {
        return;
      }
      const profileState = loadProfileState();
      const activeProfile = getActiveProfile(profileState);
      loadedBooks = loadedBooks.map((book) => withBookReadingProgress(book, activeProfile.id));
      const settings = loadReaderSettings();
      const observationFingerprint = computeObservationFingerprint(activeProfile.observations);
      const cacheMap = loadCachedBookStatsMap();

      const hasLegacySeedAlice = loadedBooks.some((book) => book.id === 'seed-alice');
      const hasNewSeedHitchhiker = loadedBooks.some((book) => book.id === 'seed-hitchhiker');
      const hasTextSeedHitchhiker = loadedBooks.some((book) => book.id === 'seed-hitchhiker' && book.sourceType === 'txt');
      if (hasLegacySeedAlice && !hasNewSeedHitchhiker) {
        seedHandleRef.current = scheduleDeferredTask(() => {
          void (async () => {
            try {
              await deleteBookById('seed-alice');
              await upsertBook(await createSeedBook());
              if (refreshRunIdRef.current === runId) {
                void refreshBooksAndStats();
              }
            } catch (error) {
              console.warn('library-legacy-seed-migration-failed', { error });
            }
          })();
        }, 1500);
      }
      if (hasTextSeedHitchhiker) {
        seedHandleRef.current = scheduleDeferredTask(() => {
          void (async () => {
            try {
              const epub = await createSeedBook();
              const previous = await getBookById(epub.id);
              if (!previous || previous.sourceType !== 'txt') return;
              await upsertBook({
                ...epub,
                createdAt: previous.createdAt,
                currentChapter: previous.currentChapter,
                currentChapterProgress: previous.currentChapterProgress,
              });
              if (refreshRunIdRef.current === runId) void refreshBooksAndStats();
            } catch (error) {
              console.warn('library-seed-epub-migration-failed', { error });
            }
          })();
        }, 1500);
      }
      setBooks(loadedBooks);
      const booksNeedingRefresh: ImportedBook[] = [];
      const cachedStatsByBookId: Record<string, BookStats> = {};
      for (const book of loadedBooks) {
        const cached = cacheMap[statsCacheKey(activeProfile.id, book.id)];
        const progressPercent = calculateProgressPercent(book);
        const isFresh = (
          !!cached
          && cached.observationFingerprint === observationFingerprint
          && cached.bookUpdatedAt === book.updatedAt
          && cached.knowledgeThreshold === settings.knowledgeThreshold
        );
        if (isFresh) {
          cachedStatsByBookId[book.id] = { ...cached.stats, progressPercent };
        } else {
          booksNeedingRefresh.push(book);
        }
      }
      setStatsByBookId(cachedStatsByBookId);
      setIsLoading(false);
      hasLoadedOnceRef.current = true;

      if (loadedBooks.length === 0) {
        seedHandleRef.current = scheduleDeferredTask(() => {
          void (async () => {
            try {
              await seedBooksIfEmpty([await createSeedBook()]);
              if (refreshRunIdRef.current === runId) {
                void refreshBooksAndStats();
              }
            } catch (error) {
              console.warn('library-seed-refresh-failed', { error });
            }
          })();
        }, 1000);
        return;
      }

      if (booksNeedingRefresh.length === 0) {
        setAnalyzingBookProgressById({});
        return;
      }

      fastStatsHandleRef.current = scheduleDeferredTask(() => {
        void (async () => {
          try {
            const model = await loadVocabularyModel();
            if (refreshRunIdRef.current !== runId) {
              return;
            }

            const processNext = async (bookIndex: number) => {
              if (refreshRunIdRef.current !== runId) {
                return;
              }
              const book = booksNeedingRefresh[bookIndex];
              if (!book) {
                return;
              }

              const stat = await calculateBookStats(
                book,
                model,
                runId,
                activeProfile,
                settings,
                (percent) => {
                  if (refreshRunIdRef.current !== runId) {
                    return;
                  }
                  setAnalyzingBookProgressById((previous) => {
                    if (previous[book.id] === percent) {
                      return previous;
                    }
                    return { ...previous, [book.id]: percent };
                  });
                },
              );
              if (stat === null || refreshRunIdRef.current !== runId) {
                return;
              }
              setStatsByBookId((previous) => ({ ...previous, [book.id]: stat }));
              setAnalyzingBookProgressById((previous) => {
                if (previous[book.id] === undefined) {
                  return previous;
                }
                const next = { ...previous };
                delete next[book.id];
                return next;
              });
              cacheMap[statsCacheKey(activeProfile.id, book.id)] = {
                stats: stat,
                observationFingerprint,
                bookUpdatedAt: book.updatedAt,
                knowledgeThreshold: settings.knowledgeThreshold,
              };
              saveCachedBookStatsMap(cacheMap);
              await yieldToEventLoop();
              await processNext(bookIndex + 1);
            };
            await processNext(0);
          } catch (error) {
            console.warn('library-fast-stats-refresh-failed', { error });
            if (refreshRunIdRef.current === runId) {
              setAnalyzingBookProgressById({});
            }
          }
        })();
      }, 0);
    } catch (error) {
      console.error('library-refresh-failed', { error });
      if (refreshRunIdRef.current === runId) {
        setAnalyzingBookProgressById({});
      }
    } finally {
      if (refreshRunIdRef.current === runId) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    void refreshBooksAndStats();
    const unsubscribe = listenStateUpdated(() => {
      void refreshBooksAndStats();
    });
    return unsubscribe;
  }, []);

  useEffect(() => () => {
    stopBackgroundAnalysis();
  }, []);

  const triggerImport = () => {
    fileInputRef.current?.click();
  };

  const deleteBook = async (book: ImportedBook): Promise<void> => {
    if (!window.confirm(`Delete "${book.title}" from your library?`)) {
      return;
    }
    setIsDeleting(true);
    stopBackgroundAnalysis();
    try {
      await deleteBookById(book.id);
      await refreshBooksAndStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete book.';
      window.alert(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const onImportFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    setIsImporting(true);
    try {
      const fileList = Array.from(files);
      for (const file of fileList) {
        const book = await importBookFromFile(file);
        await upsertBook(book);
      }
      await refreshBooksAndStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Book import failed.';
      window.alert(message);
    } finally {
      setIsImporting(false);
      event.target.value = '';
    }
  };

  return (
    <div className="h-dvh bg-background text-foreground flex flex-col overflow-hidden">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="container mx-auto px-4 md:px-6 lg:px-8 h-14 lg:h-16 flex items-center justify-between">
          <div className="font-serif text-xl lg:text-2xl font-bold tracking-tight text-primary">Easeword</div>

          <div className="flex items-center gap-1.5 md:gap-2.5 lg:gap-4">
            <Button
              variant="ghost"
              size="sm"
              className="flex gap-2 text-muted-foreground hover:text-foreground"
              onClick={triggerImport}
              disabled={isImporting}
              aria-label="Import book (TXT, EPUB, FB2, or PDF)"
              title="Import TXT, EPUB, FB2, or PDF"
            >
              <Upload size={18} />
              <span className="hidden sm:inline">{isImporting ? 'Importing...' : 'Import Book'}</span>
            </Button>

            <Button variant="ghost" size="sm" onClick={() => setQuizOpen(true)} className="gap-2 text-primary hover:bg-primary hover:text-primary-foreground transition-colors">
              <GraduationCap size={18} />
              <span className="hidden sm:inline">Quiz</span>
            </Button>

            <div className="w-px h-5 lg:h-6 bg-border mx-0.5 lg:mx-1"></div>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="text-muted-foreground hover:text-foreground"
              aria-label={resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {resolvedTheme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </Button>

            <Link href="/settings">
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" aria-label="Settings">
                <Settings size={20} />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto container mx-auto px-4 md:px-6 lg:px-8 py-8 md:py-7 lg:py-10">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.epub,.fb2,.pdf,text/plain,application/epub+zip,application/x-fictionbook+xml,application/pdf"
          multiple
          className="hidden"
          onChange={onImportFiles}
        />

        <VocabularyTestOnboarding quizOpen={quizOpen} onQuizOpenChange={setQuizOpen} />
        <VocabularyTestReminder />

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading library...</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(130px,1fr))] sm:gap-4 md:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:gap-5 lg:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] lg:gap-8">
            {books.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                stats={statsByBookId[book.id] ?? null}
                isAnalyzing={analyzingBookProgressById[book.id] !== undefined}
                analysisProgressPercent={analyzingBookProgressById[book.id] ?? 0}
                onOpen={stopBackgroundAnalysis}
                onDelete={() => { void deleteBook(book); }}
                isDeleting={isDeleting}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
