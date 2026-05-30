import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'wouter';
import { Moon, Sun, Settings, Upload, GraduationCap } from 'lucide-react';
import { useTheme } from '../components/ThemeProvider';
import { Button } from '../components/ui/button';
import { BookCard } from '../components/BookCard';
import { QuizModal } from '../components/QuizModal';
import { importBookFromFile } from '@/core/book-parser';
import { deleteBookById, listBooks, seedBooksIfEmpty, upsertBook } from '@/core/books-store';
import { createSeedBook } from '@/core/seed-book';
import { buildBookLemmaHistogramAsync, calculateBookStatsFromLemmaHistogram } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, loadReaderSettings } from '@/core/profile-store';
import { loadVocabularyModel } from '@/core/model';
import { loadLemmaDict } from '@/core/lemma';
import { loadCompromise } from '@/core/external';
import { getCachedBookLemmaHistogram, saveCachedBookLemmaHistogram } from '@/core/book-lemma-histogram-cache';
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
  currentChapter: number;
}

type CachedBookStatsMap = Record<string, CachedBookStatsEntry>;

const BOOK_STATS_CACHE_KEY = 'easeword-book-stats-cache-v1';

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
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function calculateProgressPercent(book: ImportedBook): number {
  const chapterCount = book.chapters.length;
  if (chapterCount === 0) {
    return 0;
  }
  const completedChapters = Math.max(0, Math.min(chapterCount, book.currentChapter - 1));
  const chapterProgress = (() => {
    if (typeof book.currentChapterProgress !== 'number' || !Number.isFinite(book.currentChapterProgress)) {
      return 0;
    }
    if (book.currentChapterProgress < 0) {
      return 0;
    }
    if (book.currentChapterProgress > 1) {
      return 1;
    }
    return book.currentChapterProgress;
  })();
  return ((completedChapters + chapterProgress) / chapterCount) * 100;
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
    if (typeof typed.currentChapter !== 'number' || !Number.isFinite(typed.currentChapter)) {
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

  const fallbackStats: BookStats = useMemo(() => ({
    unknownTokenCount: 0,
    unknownTokenPercent: 0,
    progressPercent: 0,
  }), []);

  const calculateBookStatsSafe = async (
    book: ImportedBook,
    model: Awaited<ReturnType<typeof loadVocabularyModel>>,
    lemmaDict: Awaited<ReturnType<typeof loadLemmaDict>>,
    nlp: Awaited<ReturnType<typeof loadCompromise>>,
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
      const cachedHistogram = getCachedBookLemmaHistogram(book.id, book.updatedAt, model.modelKey);
      if (cachedHistogram) {
        onProgress(100);
        const cachedStats = calculateBookStatsFromLemmaHistogram(cachedHistogram, settings, model, activeProfile);
        return {
          ...cachedStats,
          progressPercent,
        };
      }

      const bundledHistogram = await loadBundledBookLemmaHistogram(book.id);
      if (bundledHistogram) {
        saveCachedBookLemmaHistogram(book.id, book.updatedAt, model.modelKey, bundledHistogram);
        onProgress(100);
        const bundledStats = calculateBookStatsFromLemmaHistogram(bundledHistogram, settings, model, activeProfile);
        return {
          ...bundledStats,
          progressPercent,
        };
      }

      let lastReportedPercent = -1;
      onProgress(0);
      const histogram = await buildBookLemmaHistogramAsync(
        book,
        model,
        lemmaDict,
        nlp,
        {
          shouldContinue: () => refreshRunIdRef.current === runId,
          onParagraphProcessed: (processedParagraphs, totalParagraphs) => {
            if (totalParagraphs <= 0) {
              return;
            }
            const percent = Math.round((processedParagraphs / totalParagraphs) * 100);
            if (percent !== lastReportedPercent) {
              onProgress(percent);
              lastReportedPercent = percent;
            }
          },
          onYield: yieldToEventLoop,
          yieldEveryParagraphs: 8,
        },
      );
      if (histogram === null) {
        return null;
      }
      saveCachedBookLemmaHistogram(book.id, book.updatedAt, model.modelKey, histogram);
      const stats = calculateBookStatsFromLemmaHistogram(histogram, settings, model, activeProfile);
      return {
        ...stats,
        progressPercent,
      };
    } catch (error) {
      console.warn('library-book-stats-failed', { bookId: book.id, hasNlp: nlp !== null, error });
      return {
        ...fallbackStats,
        progressPercent,
      };
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
      const settings = loadReaderSettings();
      const observationFingerprint = computeObservationFingerprint(activeProfile.observations);
      const cacheMap = loadCachedBookStatsMap();

      const hasLegacySeedAlice = loadedBooks.some((book) => book.id === 'seed-alice');
      const hasNewSeedHitchhiker = loadedBooks.some((book) => book.id === 'seed-hitchhiker');
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
      setBooks(loadedBooks);
      const booksNeedingRefresh: ImportedBook[] = [];
      const cachedStatsByBookId: Record<string, BookStats> = {};
      const progressByBookId: Record<string, number> = {};
      for (const book of loadedBooks) {
        const cached = cacheMap[book.id];
        const progressPercent = calculateProgressPercent(book);
        progressByBookId[book.id] = progressPercent;

        if (cached) {
          cachedStatsByBookId[book.id] = {
            ...cached.stats,
            progressPercent,
          };
        }

        const isFresh = (
          !!cached
          && cached.observationFingerprint === observationFingerprint
          && cached.bookUpdatedAt === book.updatedAt
          && cached.currentChapter === book.currentChapter
        );

        if (!isFresh) {
          booksNeedingRefresh.push(book);
        }
      }
      setStatsByBookId((previous) => {
        const next: Record<string, BookStats> = {};
        for (const book of loadedBooks) {
          const bookId = book.id;
          const progressPercent = progressByBookId[bookId] ?? 0;
          const cachedStats = cachedStatsByBookId[bookId];
          if (cachedStats) {
            next[bookId] = cachedStats;
            continue;
          }
          const previousStats = previous[bookId];
          if (previousStats) {
            next[bookId] = {
              ...previousStats,
              progressPercent,
            };
            continue;
          }
          next[bookId] = {
            ...fallbackStats,
            progressPercent,
          };
        }
        return next;
      });
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

      setAnalyzingBookProgressById(() => {
        const next: Record<string, number> = {};
        for (const book of booksNeedingRefresh) {
          next[book.id] = 0;
        }
        return next;
      });

      fastStatsHandleRef.current = scheduleDeferredTask(() => {
        void (async () => {
          try {
            const [model, lemmaDict, nlp] = await Promise.all([
              loadVocabularyModel(),
              loadLemmaDict(),
              loadCompromise(),
            ]);
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

              const stat = await calculateBookStatsSafe(
                book,
                model,
                lemmaDict,
                nlp,
                runId,
                activeProfile,
                settings,
                (percent) => {
                  if (refreshRunIdRef.current !== runId) {
                    return;
                  }
                  setAnalyzingBookProgressById((previous) => {
                    if (previous[book.id] === undefined) {
                      return previous;
                    }
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
              cacheMap[book.id] = {
                stats: stat,
                observationFingerprint,
                bookUpdatedAt: book.updatedAt,
                currentChapter: book.currentChapter,
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
    void loadCompromise();
    void refreshBooksAndStats();
    const unsubscribe = listenStateUpdated(() => {
      void refreshBooksAndStats();
    });
    return unsubscribe;
  }, []);

  useEffect(() => () => {
    clearDeferredHandle(fastStatsHandleRef.current);
    fastStatsHandleRef.current = null;
    clearDeferredHandle(seedHandleRef.current);
    seedHandleRef.current = null;
  }, []);

  const triggerImport = () => {
    fileInputRef.current?.click();
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
            >
              <Upload size={18} />
              <span className="hidden sm:inline">{isImporting ? 'Importing...' : 'Import Book'}</span>
            </Button>

            <Button variant="outline" size="sm" onClick={() => setQuizOpen(true)} className="gap-2 border-primary/20 text-primary hover:bg-primary hover:text-primary-foreground transition-colors">
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
          accept=".txt,.epub"
          multiple
          className="hidden"
          onChange={onImportFiles}
        />

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading library...</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(130px,1fr))] sm:gap-4 md:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:gap-5 lg:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] lg:gap-8">
            {books.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                stats={statsByBookId[book.id] ?? fallbackStats}
                isAnalyzing={analyzingBookProgressById[book.id] !== undefined}
                analysisProgressPercent={analyzingBookProgressById[book.id] ?? 0}
              />
            ))}
          </div>
        )}
      </main>

      <QuizModal open={quizOpen} onOpenChange={setQuizOpen} />
    </div>
  );
}
