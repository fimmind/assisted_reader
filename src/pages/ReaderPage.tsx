import {
  useState, useEffect, useRef, useLayoutEffect, useCallback,
} from 'react';
import type { ReactNode } from 'react';
import { useParams, Link } from 'wouter';
import { ChevronLeft, Type, Eye, EyeOff } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/hooks/useSettings';
import { WordDefinitionCard } from '@/components/WordDefinitionCard';
import { cn } from '@/lib/utils';
import { getBookById, listBooks, upsertBook } from '@/core/books-store';
import { createFallbackLexiconEntry, loadLexiconMap } from '@/core/lexicon';
import { loadVocabularyModel } from '@/core/model';
import { loadLemmaDict } from '@/core/lemma';
import { loadCompromise } from '@/core/external';
import { analyzeChapter } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, upsertObservation } from '@/core/profile-store';
import type { ImportedBook, LexiconEntry, ParagraphAnalysis, ReaderSettings, UserProfile, VocabularyModel } from '@/core/types';

function clampChapterNumber(book: ImportedBook, chapterNumber: number | undefined): number {
  if (typeof chapterNumber !== 'number' || !Number.isFinite(chapterNumber)) {
    return 1;
  }
  const integerChapter = Math.trunc(chapterNumber);
  if (integerChapter < 1) {
    return 1;
  }
  if (integerChapter > book.chapters.length) {
    return book.chapters.length;
  }
  return integerChapter;
}

function clampChapterProgress(progress: number | undefined): number {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) {
    return 0;
  }
  if (progress < 0) {
    return 0;
  }
  if (progress > 1) {
    return 1;
  }
  return progress;
}

type NlpLike = ((text: string) => {
  terms: () => {
    json: () => Array<{ text?: string; normal?: string; tags?: string[]; terms?: Array<{ text?: string; normal?: string; tags?: string[] }> }>;
  };
  verbs: () => { toInfinitive: () => { out: (format: 'text') => string } };
  nouns: () => { toSingular: () => { out: (format: 'text') => string } };
  adjectives: () => { conjugate: () => Array<Record<string, string>> };
}) | null;

interface ReaderResources {
  model: VocabularyModel;
  lemmaDict: Record<string, string>;
  lexiconMap: Map<string, LexiconEntry>;
  nlp: NlpLike;
}

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

function calculateScrollProgressFromDocument(): number {
  const documentElement = document.documentElement;
  const maxScrollTop = Math.max(0, documentElement.scrollHeight - window.innerHeight);
  if (maxScrollTop <= 0) {
    return 0;
  }
  return clampChapterProgress(window.scrollY / maxScrollTop);
}

function calculateScrollTopFromProgress(progress: number): number {
  const normalized = clampChapterProgress(progress);
  const documentElement = document.documentElement;
  const maxScrollTop = Math.max(0, documentElement.scrollHeight - window.innerHeight);
  return maxScrollTop * normalized;
}

function buildParagraphAnalysisAtIndex(
  selectedBook: ImportedBook,
  settings: ReaderSettings,
  profile: UserProfile,
  resources: ReaderResources,
  paragraphIndex: number,
  assistanceEnabled: boolean,
): ParagraphAnalysis {
  const chapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
  const chapterIndex = chapterNumber - 1;
  const chapter = selectedBook.chapters[chapterIndex];
  if (!chapter) {
    return { paragraphText: '', tokens: [], cardLemmas: [] };
  }
  const paragraphText = chapter.paragraphs[paragraphIndex] ?? '';
  if (!assistanceEnabled) {
    return { paragraphText, tokens: [], cardLemmas: [] };
  }

  const analyses = analyzeChapter({
    chapter: {
      title: chapter.title,
      paragraphs: [paragraphText],
    },
    settings,
    model: resources.model,
    profile,
    lemmaDict: resources.lemmaDict,
    nlp: resources.nlp,
    maxCardsPerParagraph: Math.max(1, Math.min(3, settings.maxWordsPerParagraph)),
  });

  return analyses[0] ?? { paragraphText, tokens: [], cardLemmas: [] };
}

function buildPlainChapterAnalysis(selectedBook: ImportedBook): ParagraphAnalysis[] {
  const chapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
  const chapterIndex = chapterNumber - 1;
  const chapter = selectedBook.chapters[chapterIndex];
  if (!chapter) {
    return [];
  }
  return chapter.paragraphs.map((paragraphText) => ({ paragraphText, tokens: [], cardLemmas: [] }));
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isChapterHeadingText(text: string): boolean {
  return /^chapter\b/i.test(normalizeHeadingText(text));
}

function isGenericChapterHeading(text: string): boolean {
  const normalized = normalizeHeadingText(text).toLowerCase();
  return normalized === 'chapter' || normalized === 'chapter.';
}

function resolveChapterDisplayTitle(
  chapterTitle: string | undefined,
  chapterNumber: number,
  firstParagraph: string | undefined,
): string {
  const fallbackTitle = `Chapter ${chapterNumber}`;
  const normalizedTitle = chapterTitle ? normalizeHeadingText(chapterTitle) : '';
  const normalizedFirstParagraph = firstParagraph ? normalizeHeadingText(firstParagraph) : '';

  if (normalizedTitle.length === 0) {
    if (normalizedFirstParagraph.length > 0 && isChapterHeadingText(normalizedFirstParagraph)) {
      return normalizedFirstParagraph;
    }
    return fallbackTitle;
  }

  if (isGenericChapterHeading(normalizedTitle)) {
    if (normalizedFirstParagraph.length > 0 && isChapterHeadingText(normalizedFirstParagraph)) {
      return normalizedFirstParagraph;
    }
    return fallbackTitle;
  }

  return normalizedTitle;
}

function shouldHideFirstParagraphAsDuplicateTitle(
  chapterDisplayTitle: string,
  firstParagraph: string | undefined,
): boolean {
  if (!firstParagraph) {
    return false;
  }
  const normalizedParagraph = normalizeHeadingText(firstParagraph);
  if (!isChapterHeadingText(normalizedParagraph)) {
    return false;
  }
  return normalizedParagraph.toLowerCase() === normalizeHeadingText(chapterDisplayTitle).toLowerCase();
}

export default function ReaderPage() {
  const { bookId } = useParams();
  const { settings, updateSetting } = useSettings();

  const [book, setBook] = useState<ImportedBook | null>(null);
  const [assistanceEnabled, setAssistanceEnabled] = useState(true);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [chapterAnalysis, setChapterAnalysis] = useState<ParagraphAnalysis[]>([]);
  const [definitionsByLemma, setDefinitionsByLemma] = useState<Map<string, LexiconEntry>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const resourcesRef = useRef<ReaderResources | null>(null);
  const bookRef = useRef<ImportedBook | null>(null);
  const settingsRef = useRef<ReaderSettings>(settings);
  const assistanceEnabledRef = useRef<boolean>(assistanceEnabled);
  const analysisRunIdRef = useRef(0);
  const deferredAnalysisHandleRef = useRef<DeferredHandle | null>(null);
  const progressPersistTimeoutRef = useRef<number | null>(null);
  const delayedRestoreTimeoutRef = useRef<number | null>(null);
  const isRestoringProgressRef = useRef(false);
  const lastPersistedChapterProgressRef = useRef(0);

  const lastScrollY = useRef(0);

  const rowRef = useRef<HTMLDivElement>(null);
  const textColRef = useRef<HTMLDivElement>(null);
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const cardGrpRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [paraOffsets, setParaOffsets] = useState<number[]>([]);
  const extraPaddingRef = useRef(0);
  const [extraPadding, _setExtraPadding] = useState(0);
  const setExtraPadding = useCallback((value: number) => {
    extraPaddingRef.current = value;
    _setExtraPadding((previous) => previous === value ? previous : value);
  }, []);

  const recomputeVisibleAnalysis = useCallback((selectedBook: ImportedBook, resources: ReaderResources) => {
    const profileState = loadProfileState();
    const activeProfile = getActiveProfile(profileState);
    const currentRunId = analysisRunIdRef.current + 1;
    analysisRunIdRef.current = currentRunId;
    const expectedParagraphCount = buildPlainChapterAnalysis(selectedBook).length;

    const plainAnalyses = buildPlainChapterAnalysis(selectedBook);
    setChapterAnalysis(plainAnalyses);
    setDefinitionsByLemma(new Map());
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;

    if (!assistanceEnabledRef.current) {
      return;
    }

    deferredAnalysisHandleRef.current = scheduleDeferredTask(() => {
      if (analysisRunIdRef.current !== currentRunId) {
        return;
      }

      void (async () => {
        try {
          const nextAnalyses = plainAnalyses.slice();
          const definitionMap = new Map<string, LexiconEntry>();

          for (let paragraphIndex = 0; paragraphIndex < expectedParagraphCount; paragraphIndex += 1) {
            if (analysisRunIdRef.current !== currentRunId) {
              return;
            }

            try {
              const analysis = buildParagraphAnalysisAtIndex(
                selectedBook,
                settingsRef.current,
                activeProfile,
                resources,
                paragraphIndex,
                true,
              );
              nextAnalyses[paragraphIndex] = analysis;

              for (const lemma of analysis.cardLemmas) {
                const found = resources.lexiconMap.get(lemma) ?? createFallbackLexiconEntry(lemma);
                definitionMap.set(lemma, found);
              }
            } catch (error) {
              console.warn('reader-paragraph-analysis-failed', {
                error,
                chapter: selectedBook.currentChapter,
                paragraphIndex,
                bookId: selectedBook.id,
              });
            }

            if (analysisRunIdRef.current !== currentRunId) {
              return;
            }

            setChapterAnalysis([...nextAnalyses]);
            setDefinitionsByLemma(new Map(definitionMap));

            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            });
          }
        } catch (error) {
          console.warn('reader-analysis-failed', { error, chapter: selectedBook.currentChapter, bookId: selectedBook.id });
        }
      })();
    }, 700);
  }, []);

  const loadReaderState = useCallback(async () => {
    setIsLoading(true);

    try {
      const preferredBook = bookId ? await getBookById(bookId) : null;
      const selectedBook = preferredBook ?? (await listBooks())[0] ?? null;
      if (!selectedBook) {
        setBook(null);
        setChapterAnalysis([]);
        setDefinitionsByLemma(new Map());
        resourcesRef.current = null;
        return;
      }

      const [model, lemmaDict, lexiconMap, nlp] = await Promise.all([
        loadVocabularyModel(),
        loadLemmaDict(),
        loadLexiconMap(),
        loadCompromise(),
      ]);

      const resources: ReaderResources = { model, lemmaDict, lexiconMap, nlp };
      resourcesRef.current = resources;

      setBook(selectedBook);
      recomputeVisibleAnalysis(selectedBook, resources);
    } catch (error) {
      console.error('reader-load-failed', { error, bookId });
    } finally {
      setIsLoading(false);
    }
  }, [bookId, recomputeVisibleAnalysis]);

  useEffect(() => {
    bookRef.current = book;
  }, [book]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    assistanceEnabledRef.current = assistanceEnabled;
  }, [assistanceEnabled]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!book || !resources || isLoading) {
      return;
    }
    recomputeVisibleAnalysis(book, resources);
  }, [assistanceEnabled, book, isLoading, recomputeVisibleAnalysis, settings]);

  useEffect(() => {
    void loadReaderState();
    const unsubscribe = listenStateUpdated(() => {
      const resources = resourcesRef.current;
      const currentBook = bookRef.current;
      if (!currentBook || !resources) {
        void loadReaderState();
        return;
      }
      recomputeVisibleAnalysis(currentBook, resources);
    });
    return unsubscribe;
  }, [loadReaderState, recomputeVisibleAnalysis]);

  useEffect(() => () => {
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;
  }, []);

  const markLemma = (lemma: string, known: boolean) => {
    upsertObservation(lemma, known);
    const resources = resourcesRef.current;
    if (book && resources) {
      recomputeVisibleAnalysis(book, resources);
    }
  };

  const persistCurrentChapterProgress = useCallback((force: boolean) => {
    const currentBook = bookRef.current;
    if (!currentBook) {
      return;
    }
    if (!force && isRestoringProgressRef.current) {
      return;
    }

    const progress = calculateScrollProgressFromDocument();
    if (!force && Math.abs(progress - lastPersistedChapterProgressRef.current) < 0.01) {
      return;
    }
    lastPersistedChapterProgressRef.current = progress;

    const nextBook: ImportedBook = {
      ...currentBook,
      currentChapterProgress: progress,
    };
    bookRef.current = nextBook;
    void upsertBook(nextBook).catch((error) => {
      console.warn('reader-scroll-progress-save-failed', { bookId: nextBook.id, chapter: nextBook.currentChapter, progress, error });
    });
  }, []);

  const scheduleChapterProgressPersist = useCallback(() => {
    if (progressPersistTimeoutRef.current !== null) {
      window.clearTimeout(progressPersistTimeoutRef.current);
    }
    progressPersistTimeoutRef.current = window.setTimeout(() => {
      progressPersistTimeoutRef.current = null;
      persistCurrentChapterProgress(false);
    }, 250);
  }, [persistCurrentChapterProgress]);

  const restoreCurrentChapterProgress = useCallback((targetBook: ImportedBook) => {
    const targetScrollTop = calculateScrollTopFromProgress(targetBook.currentChapterProgress);
    window.scrollTo({ top: targetScrollTop, behavior: 'auto' });
  }, []);

  const updateCurrentChapter = async (delta: number) => {
    if (!book) {
      return;
    }
    persistCurrentChapterProgress(true);
    const currentChapterNumber = clampChapterNumber(book, book.currentChapter);
    const nextChapter = clampChapterNumber(book, currentChapterNumber + delta);
    if (nextChapter === currentChapterNumber) {
      return;
    }

    const nextBook: ImportedBook = {
      ...book,
      currentChapter: nextChapter,
      currentChapterProgress: 0,
      updatedAt: new Date().toISOString(),
    };
    setBook(nextBook);
    window.scrollTo({ top: 0, behavior: 'auto' });
    void upsertBook(nextBook).catch((error) => {
      console.warn('reader-chapter-progress-save-failed', { bookId: nextBook.id, chapter: nextBook.currentChapter, error });
    });
  };

  const rafIdRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (window.innerWidth < 768) {
        setExtraPadding(0);
        return;
      }
      if (!rowRef.current || !textColRef.current) return;

      const rowRect = rowRef.current.getBoundingClientRect();
      const rowStyles = window.getComputedStyle(rowRef.current);
      const rowPaddingTop = Number.parseFloat(rowStyles.paddingTop) || 0;
      const rowTop = rowRect.top + rowPaddingTop;
      const rawOffsets = paraRefs.current.map((element) =>
        element ? (element.getBoundingClientRect().top - rowTop) : 0
      );
      const newOffsets = [...rawOffsets];
      const minCardGap = 12;
      let nextMinTop = 0;
      cardGrpRefs.current.forEach((element, index) => {
        if (!element) {
          return;
        }
        const desiredTop = rawOffsets[index] ?? 0;
        const adjustedTop = Math.max(desiredTop, nextMinTop);
        newOffsets[index] = adjustedTop;
        nextMinTop = adjustedTop + element.offsetHeight + minCardGap;
      });
      setParaOffsets((previous) =>
        previous.length === newOffsets.length && previous.every((value, index) => value === newOffsets[index])
          ? previous : [...newOffsets]);

      const textElement = textColRef.current;
      const naturalTextHeight = textElement.scrollHeight - extraPaddingRef.current;
      const textTop = textElement.getBoundingClientRect().top - rowTop;
      const textBottom = textTop + naturalTextHeight;

      let maxOverflow = 0;
      cardGrpRefs.current.forEach((element, index) => {
        if (!element) return;
        const cardBottom = (newOffsets[index] ?? 0) + element.offsetHeight;
        if (cardBottom > textBottom) {
          maxOverflow = Math.max(maxOverflow, cardBottom - textBottom);
        }
      });

      setExtraPadding(maxOverflow > 0 ? maxOverflow + 24 : 0);
    });
  }, [setExtraPadding]);

  useLayoutEffect(() => {
    measure();
  }, [measure, chapterAnalysis, settings.fontSize, settings.lineSpacing, settings.fontChoice, settings.pageWidth, settings.maxWordsPerParagraph, assistanceEnabled]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  useEffect(() => {
    if (!book || isLoading) {
      return;
    }
    isRestoringProgressRef.current = true;
    lastPersistedChapterProgressRef.current = clampChapterProgress(book.currentChapterProgress);
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }

    requestAnimationFrame(() => {
      restoreCurrentChapterProgress(book);
    });
    delayedRestoreTimeoutRef.current = window.setTimeout(() => {
      restoreCurrentChapterProgress(book);
      isRestoringProgressRef.current = false;
      delayedRestoreTimeoutRef.current = null;
    }, 900);
  }, [book, isLoading, restoreCurrentChapterProgress]);

  useEffect(() => {
    const handleScroll = () => {
      const y = window.scrollY;
      if (y > lastScrollY.current && y > 100) setHeaderVisible(false);
      else if (y < lastScrollY.current) setHeaderVisible(true);
      lastScrollY.current = y;
      if (isRestoringProgressRef.current) {
        return;
      }
      scheduleChapterProgressPersist();
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [scheduleChapterProgressPersist]);

  useEffect(() => () => {
    if (progressPersistTimeoutRef.current !== null) {
      window.clearTimeout(progressPersistTimeoutRef.current);
      progressPersistTimeoutRef.current = null;
    }
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }
    isRestoringProgressRef.current = false;
  }, []);

  useEffect(() => {
    const persistOnPageHide = () => {
      persistCurrentChapterProgress(true);
    };
    const persistOnVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentChapterProgress(true);
      }
    };
    window.addEventListener('pagehide', persistOnPageHide);
    document.addEventListener('visibilitychange', persistOnVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', persistOnPageHide);
      document.removeEventListener('visibilitychange', persistOnVisibilityChange);
    };
  }, [persistCurrentChapterProgress]);

  const getTextFontClasses = () => cn(
    settings.fontChoice === 'Sans' ? 'font-sans' : 'font-serif',
    settings.lineSpacing === 'Compact' ? 'leading-snug' :
    settings.lineSpacing === 'Relaxed' ? 'leading-loose' : 'leading-relaxed'
  );

  const getOuterWidthClass = () =>
    settings.pageWidth === 'Narrow' ? 'max-w-4xl' :
    settings.pageWidth === 'Wide' ? 'max-w-6xl' : 'max-w-5xl';

  const renderParagraphWithHighlights = (analysis: ParagraphAnalysis): ReactNode => {
    if (!assistanceEnabled || analysis.tokens.length === 0 || analysis.cardLemmas.length === 0) {
      return <>{analysis.paragraphText}</>;
    }

    const highlightedLemmas = new Set<string>(analysis.cardLemmas);
    const nodes: ReactNode[] = [];
    let cursor = 0;

    for (let index = 0; index < analysis.tokens.length; index += 1) {
      const token = analysis.tokens[index];
      if (token.start > cursor) {
        nodes.push(analysis.paragraphText.slice(cursor, token.start));
      }

      const tokenText = analysis.paragraphText.slice(token.start, token.end);
      const shouldHighlight = token.unknown && highlightedLemmas.has(token.lemma);
      if (!shouldHighlight) {
        nodes.push(tokenText);
      } else {
        const isPriority = (1 - token.pKnown) > 0.6;
        nodes.push(
          <span
            key={`${token.lemma}-${token.start}`}
            className={cn(
              'cursor-pointer rounded-sm px-0.5 -mx-0.5',
              isPriority ? 'unknown-word priority' : 'unknown-word',
            )}
          >
            {tokenText}
          </span>,
        );
      }
      cursor = token.end;
    }

    if (cursor < analysis.paragraphText.length) {
      nodes.push(analysis.paragraphText.slice(cursor));
    }

    return <>{nodes}</>;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        Loading reader...
      </div>
    );
  }

  if (!book) {
    return <div className="min-h-screen bg-background text-foreground p-6">No books found in your library.</div>;
  }
  const currentChapterNumber = clampChapterNumber(book, book.currentChapter);
  const currentChapter = book.chapters[currentChapterNumber - 1];
  const chapterParagraphs = currentChapter?.paragraphs ?? [];
  const chapterDisplayTitle = resolveChapterDisplayTitle(
    currentChapter?.title,
    currentChapterNumber,
    chapterParagraphs[0],
  );
  const paragraphStartIndex = shouldHideFirstParagraphAsDuplicateTitle(chapterDisplayTitle, chapterParagraphs[0]) ? 1 : 0;
  const visibleParagraphEntries = chapterParagraphs.slice(paragraphStartIndex).map((paragraphText, visibleIndex) => ({
    paragraphText,
    visibleIndex,
    sourceIndex: visibleIndex + paragraphStartIndex,
  }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      {readerSettingsOpen && (
        <div
          className="fixed inset-0 z-10 bg-black/20"
          aria-hidden="true"
          onClick={() => setReaderSettingsOpen(false)}
        />
      )}
      <header className={cn(
        'fixed top-0 inset-x-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border transition-transform duration-300',
        headerVisible ? 'translate-y-0' : '-translate-y-full'
      )}>
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              data-testid="button-back-library"
              onClick={() => persistCurrentChapterProgress(true)}
            >
              <ChevronLeft size={18} /><span className="hidden sm:inline">Library</span>
            </Button>
          </Link>
          <div className="font-serif text-sm font-medium text-muted-foreground hidden md:block">
            {book.title} — Chapter {currentChapterNumber}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon"
              onClick={() => setAssistanceEnabled(!assistanceEnabled)}
              className={cn('text-muted-foreground transition-colors', assistanceEnabled && 'text-primary bg-primary/10')}
              aria-label="Toggle vocabulary assistance" data-testid="button-toggle-assistance">
              {assistanceEnabled ? <Eye size={18} /> : <EyeOff size={18} />}
            </Button>
            <Sheet modal={false} open={readerSettingsOpen} onOpenChange={setReaderSettingsOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground" data-testid="button-reader-settings">
                  <Type size={18} />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" disableAnimation className="w-[300px] sm:w-[400px] overflow-y-auto">
                <SheetHeader className="mb-6">
                  <SheetTitle className="font-serif">Reader Settings</SheetTitle>
                </SheetHeader>
                <div className="space-y-8">
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Font Size</Label>
                    <div className="flex items-center gap-4">
                      <span className="text-sm">A</span>
                      <Slider value={[settings.fontSize]} min={12} max={32} step={1}
                        onValueChange={([value]) => updateSetting('fontSize', value)} className="flex-1" />
                      <span className="text-lg">A</span>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Font Family</Label>
                    <div className="grid grid-cols-2 gap-3">
                      {(['Serif', 'Sans'] as const).map((font) => (
                        <Button key={font} variant={settings.fontChoice === font ? 'default' : 'outline'}
                          className={cn('h-12', font === 'Serif' ? 'font-serif' : 'font-sans')}
                          onClick={() => updateSetting('fontChoice', font)} data-testid={`button-font-${font.toLowerCase()}`}>
                          {font}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Line Spacing</Label>
                    <div className="grid grid-cols-3 gap-3">
                      {(['Compact', 'Normal', 'Relaxed'] as const).map((spacing) => (
                        <Button key={spacing} variant={settings.lineSpacing === spacing ? 'default' : 'outline'} size="sm"
                          onClick={() => updateSetting('lineSpacing', spacing)} data-testid={`button-spacing-${spacing.toLowerCase()}`}>
                          {spacing}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Page Width</Label>
                    <div className="grid grid-cols-3 gap-3">
                      {(['Narrow', 'Normal', 'Wide'] as const).map((width) => (
                        <Button key={width} variant={settings.pageWidth === width ? 'default' : 'outline'} size="sm"
                          onClick={() => updateSetting('pageWidth', width)} data-testid={`button-width-${width.toLowerCase()}`}>
                          {width}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <div className="h-14" />

      <main
        className={cn('mx-auto px-4 sm:px-6', getOuterWidthClass())}
        onClick={() => setHeaderVisible(true)}
      >
        <div
          ref={rowRef}
          className="relative flex items-start gap-5 py-12 md:py-20"
          data-testid="reading-row"
        >
          <div className="flex-1 min-w-0 flex flex-col" data-testid="left-column">
            <h1 className="text-3xl md:text-5xl font-medium mb-12 text-center text-foreground/90 font-serif">
              {chapterDisplayTitle}
            </h1>

            <div
              ref={textColRef}
              className={cn(getTextFontClasses())}
              style={{
                fontSize: `${settings.fontSize}px`,
                paddingBottom: extraPadding,
              }}
              data-testid="text-column"
            >
              {visibleParagraphEntries.map((entry) => {
                const analysis = chapterAnalysis[entry.sourceIndex] ?? { paragraphText: entry.paragraphText, tokens: [], cardLemmas: [] };
                return (
                <div key={entry.sourceIndex} className="mb-2" data-testid={`paragraph-block-${entry.visibleIndex}`}>
                  <p
                    ref={(element) => { paraRefs.current[entry.visibleIndex] = element; }}
                    className="text-foreground/90 reader-text"
                    data-testid={`paragraph-${entry.visibleIndex}`}
                  >
                    {renderParagraphWithHighlights(analysis)}
                  </p>
                  {assistanceEnabled && analysis.cardLemmas.length > 0 && (
                    <div className="md:hidden mt-3 flex flex-col gap-3" data-testid={`mobile-card-group-${entry.visibleIndex}`}>
                      {analysis.cardLemmas.map((lemma) => {
                        const definition = definitionsByLemma.get(lemma) ?? createFallbackLexiconEntry(lemma);
                        return (
                          <WordDefinitionCard
                            key={lemma}
                            definition={definition}
                            onMarkKnown={() => markLemma(lemma, true)}
                            onMarkUnknown={() => markLemma(lemma, false)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            <div className="mt-20 pt-8 border-t border-border flex justify-between items-center text-muted-foreground font-serif">
              <Button variant="ghost" className="gap-2" data-testid="button-prev-chapter" onClick={() => void updateCurrentChapter(-1)}>
                <ChevronLeft size={16} /> Previous Chapter
              </Button>
              <span className="text-sm" data-testid="text-page-info">
                Chapter {currentChapterNumber} of {book.chapters.length}
              </span>
              <Button variant="ghost" className="gap-2" data-testid="button-next-chapter" onClick={() => void updateCurrentChapter(1)}>
                Next Chapter <ChevronLeft size={16} className="rotate-180" />
              </Button>
            </div>
          </div>

          <div
            className="hidden md:block relative w-[300px] flex-shrink-0"
            style={{ minHeight: 1 }}
            aria-label="Vocabulary cards"
            data-testid="card-column"
          >
            {visibleParagraphEntries.map((entry) => {
              const analysis = chapterAnalysis[entry.sourceIndex] ?? { paragraphText: entry.paragraphText, tokens: [], cardLemmas: [] };
              if (!analysis.cardLemmas.length || !assistanceEnabled) return null;
              return (
                <div
                  key={entry.sourceIndex}
                  ref={(element) => { cardGrpRefs.current[entry.visibleIndex] = element; }}
                  style={{ position: 'absolute', top: paraOffsets[entry.visibleIndex] ?? 0 }}
                  className="flex flex-col gap-3 w-full"
                  data-testid={`card-group-${entry.visibleIndex}`}
                >
                  {analysis.cardLemmas.map((lemma) => {
                    const definition = definitionsByLemma.get(lemma) ?? createFallbackLexiconEntry(lemma);
                    return (
                      <WordDefinitionCard
                        key={lemma}
                        definition={definition}
                        onMarkKnown={() => markLemma(lemma, true)}
                        onMarkUnknown={() => markLemma(lemma, false)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
