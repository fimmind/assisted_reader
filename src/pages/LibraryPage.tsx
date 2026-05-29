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
import { analyzeChapter } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, loadReaderSettings } from '@/core/profile-store';
import { loadVocabularyModel } from '@/core/model';
import { loadLemmaDict } from '@/core/lemma';
import { loadCompromise } from '@/core/external';
import type { BookStats, ImportedBook } from '@/core/types';

type DeferredHandle = {
  kind: 'idle' | 'timeout';
  id: number;
};

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

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
    window.setTimeout(resolve, 0);
  });
}

export default function LibraryPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const [quizOpen, setQuizOpen] = useState(false);
  const [books, setBooks] = useState<ImportedBook[]>([]);
  const [statsByBookId, setStatsByBookId] = useState<Record<string, BookStats>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const refreshRunIdRef = useRef(0);
  const fastStatsHandleRef = useRef<DeferredHandle | null>(null);
  const nlpStatsHandleRef = useRef<DeferredHandle | null>(null);
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
  ): Promise<BookStats | null> => {
    const profileState = loadProfileState();
    const activeProfile = getActiveProfile(profileState);
    const settings = loadReaderSettings();
    const chapterCount = book.chapters.length;
    const progressPercent = chapterCount === 0 ? 0 : (book.currentChapter / chapterCount) * 100;
    if (chapterCount === 0) {
      return {
        ...fallbackStats,
        progressPercent,
      };
    }
    const safeChapterIndex = Math.max(0, Math.min(chapterCount - 1, book.currentChapter - 1));
    const chapter = book.chapters[safeChapterIndex];
    const sampleLimit = nlp === null ? 12 : 24;
    const sampledParagraphs = chapter.paragraphs.slice(0, sampleLimit);
    if (sampledParagraphs.length === 0) {
      return {
        ...fallbackStats,
        progressPercent,
      };
    }

    try {
      let sampledUnknownTokens = 0;
      let sampledTotalTokens = 0;
      for (let paragraphIndex = 0; paragraphIndex < sampledParagraphs.length; paragraphIndex += 1) {
        if (refreshRunIdRef.current !== runId) {
          return null;
        }

        const paragraphText = sampledParagraphs[paragraphIndex];
        const analyses = analyzeChapter({
          chapter: {
            title: chapter.title,
            paragraphs: [paragraphText],
          },
          settings,
          model,
          profile: activeProfile,
          lemmaDict,
          nlp,
          maxCardsPerParagraph: 1,
        });
        const paragraph = analyses[0];
        if (!paragraph) {
          continue;
        }

        for (const token of paragraph.tokens) {
          sampledTotalTokens += 1;
          if (token.unknown) {
            sampledUnknownTokens += 1;
          }
        }

        await yieldToEventLoop();
      }

      if (refreshRunIdRef.current !== runId) {
        return null;
      }

      const unknownTokenPercent = sampledTotalTokens === 0 ? 0 : (sampledUnknownTokens / sampledTotalTokens) * 100;
      const scale = chapter.paragraphs.length / sampledParagraphs.length;
      const unknownTokenCount = Math.max(0, Math.round(sampledUnknownTokens * scale));

      return {
        unknownTokenCount,
        unknownTokenPercent,
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
    clearDeferredHandle(fastStatsHandleRef.current);
    fastStatsHandleRef.current = null;
    clearDeferredHandle(nlpStatsHandleRef.current);
    nlpStatsHandleRef.current = null;
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
      const nextFallbackStats: Record<string, BookStats> = {};
      for (const book of loadedBooks) {
        nextFallbackStats[book.id] = fallbackStats;
      }
      setStatsByBookId(nextFallbackStats);
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

      fastStatsHandleRef.current = scheduleDeferredTask(() => {
        void (async () => {
          try {
            const [model, lemmaDict] = await Promise.all([
              loadVocabularyModel(),
              loadLemmaDict(),
            ]);
            if (refreshRunIdRef.current !== runId) {
              return;
            }
            let fastIndex = 0;
            const processFastNext = async () => {
              if (refreshRunIdRef.current !== runId) {
                return;
              }
              const book = loadedBooks[fastIndex];
              if (!book) {
                nlpStatsHandleRef.current = scheduleDeferredTask(() => {
                  void (async () => {
                    try {
                      const nlp = await loadCompromise();
                      if (refreshRunIdRef.current !== runId || nlp === null) {
                        return;
                      }
                      let nlpIndex = 0;
                      const processNlpNext = async () => {
                        if (refreshRunIdRef.current !== runId) {
                          return;
                        }
                        const nlpBook = loadedBooks[nlpIndex];
                        if (!nlpBook) {
                          return;
                        }
                        const stat = await calculateBookStatsSafe(nlpBook, model, lemmaDict, nlp, runId);
                        if (stat === null || refreshRunIdRef.current !== runId) {
                          return;
                        }
                        setStatsByBookId((previous) => ({ ...previous, [nlpBook.id]: stat }));
                        nlpIndex += 1;
                        nlpStatsHandleRef.current = scheduleDeferredTask(() => {
                          void processNlpNext();
                        }, 80);
                      };
                      void processNlpNext();
                    } catch (error) {
                      console.warn('library-nlp-stats-refresh-failed', { error });
                    }
                  })();
                }, 1000);
                return;
              }
              const stat = await calculateBookStatsSafe(book, model, lemmaDict, null, runId);
              if (stat === null || refreshRunIdRef.current !== runId) {
                return;
              }
              setStatsByBookId((previous) => ({ ...previous, [book.id]: stat }));
              fastIndex += 1;
              fastStatsHandleRef.current = scheduleDeferredTask(() => {
                void processFastNext();
              }, 60);
            };
            void processFastNext();
          } catch (error) {
            console.warn('library-fast-stats-refresh-failed', { error });
          }
        })();
      }, 300);
    } catch (error) {
      console.error('library-refresh-failed', { error });
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
    clearDeferredHandle(fastStatsHandleRef.current);
    fastStatsHandleRef.current = null;
    clearDeferredHandle(nlpStatsHandleRef.current);
    nlpStatsHandleRef.current = null;
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
              <BookCard key={book.id} book={book} stats={statsByBookId[book.id] ?? fallbackStats} />
            ))}
          </div>
        )}
      </main>

      <QuizModal open={quizOpen} onOpenChange={setQuizOpen} />
    </div>
  );
}
