import {
  useState, useEffect, useRef, useLayoutEffect, useCallback,
} from 'react';
import type { ReactNode } from 'react';
import { useParams, Link } from 'wouter';
import { ChevronLeft, MoreHorizontal, Bookmark, Type, Eye, EyeOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import type { ImportedBook, LexiconEntry, ParagraphAnalysis } from '@/core/types';

function clampChapterNumber(book: ImportedBook, chapterNumber: number): number {
  if (chapterNumber < 1) {
    return 1;
  }
  if (chapterNumber > book.chapters.length) {
    return book.chapters.length;
  }
  return chapterNumber;
}

export default function ReaderPage() {
  const { bookId } = useParams();
  const { settings, updateSetting } = useSettings();

  const [book, setBook] = useState<ImportedBook | null>(null);
  const [assistanceEnabled, setAssistanceEnabled] = useState(true);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [chapterAnalysis, setChapterAnalysis] = useState<ParagraphAnalysis[]>([]);
  const [definitionsByLemma, setDefinitionsByLemma] = useState<Map<string, LexiconEntry>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

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

  const loadReaderState = useCallback(async () => {
    setIsLoading(true);

    try {
      const preferredBook = bookId ? await getBookById(bookId) : null;
      const selectedBook = preferredBook ?? (await listBooks())[0] ?? null;
      if (!selectedBook) {
        setBook(null);
        setChapterAnalysis([]);
        setDefinitionsByLemma(new Map());
        return;
      }

      const [model, lemmaDict, lexiconMap, nlp] = await Promise.all([
        loadVocabularyModel(),
        loadLemmaDict(),
        loadLexiconMap(),
        loadCompromise(),
      ]);

      const profileState = loadProfileState();
      const activeProfile = getActiveProfile(profileState);
      const chapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
      const chapterIndex = chapterNumber - 1;
      const chapter = selectedBook.chapters[chapterIndex];
      const maxCardsPerParagraph = Math.max(1, Math.min(3, settings.maxWordsPerParagraph));

      const analyses = assistanceEnabled
        ? analyzeChapter({
            chapter,
            settings,
            model,
            profile: activeProfile,
            lemmaDict,
            nlp,
            maxCardsPerParagraph,
          })
        : chapter.paragraphs.map((paragraphText) => ({ paragraphText, tokens: [], cardLemmas: [] }));

      const definitionMap = new Map<string, LexiconEntry>();
      for (const paragraph of analyses) {
        for (const lemma of paragraph.cardLemmas) {
          const found = lexiconMap.get(lemma) ?? createFallbackLexiconEntry(lemma);
          definitionMap.set(lemma, found);
        }
        for (const token of paragraph.tokens) {
          if (token.unknown) {
            const found = lexiconMap.get(token.lemma) ?? createFallbackLexiconEntry(token.lemma);
            if (!definitionMap.has(token.lemma)) {
              definitionMap.set(token.lemma, found);
            }
          }
        }
      }

      setBook(selectedBook);
      setChapterAnalysis(analyses);
      setDefinitionsByLemma(definitionMap);
    } catch (error) {
      console.error('reader-load-failed', { error, bookId });
    } finally {
      setIsLoading(false);
    }
  }, [assistanceEnabled, bookId, settings]);

  useEffect(() => {
    void loadReaderState();
    const unsubscribe = listenStateUpdated(() => {
      void loadReaderState();
    });
    return unsubscribe;
  }, [loadReaderState]);

  const markLemma = (lemma: string, known: boolean) => {
    upsertObservation(lemma, known);
  };

  const updateCurrentChapter = async (delta: number) => {
    if (!book) {
      return;
    }
    const nextChapter = clampChapterNumber(book, book.currentChapter + delta);
    if (nextChapter === book.currentChapter) {
      return;
    }

    const nextBook: ImportedBook = {
      ...book,
      currentChapter: nextChapter,
      updatedAt: new Date().toISOString(),
    };
    await upsertBook(nextBook);
    setBook(nextBook);
    void loadReaderState();
  };

  const rafIdRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (!rowRef.current || !textColRef.current) return;

      const newOffsets = paraRefs.current.map((element) => (element ? element.offsetTop : 0));
      setParaOffsets((previous) =>
        previous.length === newOffsets.length && previous.every((value, index) => value === newOffsets[index])
          ? previous : [...newOffsets]);

      const textElement = textColRef.current;
      const naturalTextHeight = textElement.scrollHeight - extraPaddingRef.current;
      const textBottom = textElement.offsetTop + naturalTextHeight;

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
    const handleScroll = () => {
      const y = window.scrollY;
      if (y > lastScrollY.current && y > 100) setHeaderVisible(false);
      else if (y < lastScrollY.current) setHeaderVisible(true);
      lastScrollY.current = y;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const getTextFontClasses = () => cn(
    settings.fontChoice === 'Sans' ? 'font-sans' : 'font-serif',
    settings.lineSpacing === 'Compact' ? 'leading-snug' :
    settings.lineSpacing === 'Relaxed' ? 'leading-loose' : 'leading-relaxed'
  );

  const getOuterWidthClass = () =>
    settings.pageWidth === 'Narrow' ? 'max-w-4xl' :
    settings.pageWidth === 'Wide' ? 'max-w-6xl' : 'max-w-5xl';

  const renderParagraph = (analysis: ParagraphAnalysis) => {
    if (!assistanceEnabled || analysis.tokens.length === 0) {
      return <>{analysis.paragraphText}</>;
    }

    const nodes: ReactNode[] = [];
    let cursor = 0;

    for (let index = 0; index < analysis.tokens.length; index += 1) {
      const token = analysis.tokens[index];
      if (token.start > cursor) {
        nodes.push(analysis.paragraphText.slice(cursor, token.start));
      }

      const tokenText = analysis.paragraphText.slice(token.start, token.end);
      if (!token.unknown) {
        nodes.push(tokenText);
        cursor = token.end;
        continue;
      }

      const definition = definitionsByLemma.get(token.lemma) ?? createFallbackLexiconEntry(token.lemma);
      const isPriority = (1 - token.pKnown) > 0.6;
      nodes.push(
        <Popover key={`${token.lemma}-${token.start}`}>
          <PopoverTrigger asChild>
            <span
              className={cn(
                'cursor-pointer rounded-sm px-0.5 -mx-0.5',
                isPriority ? 'unknown-word priority' : 'unknown-word'
              )}
            >
              {tokenText}
            </span>
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="p-0 w-auto border-none shadow-lg">
            <WordDefinitionCard
              definition={definition}
              onMarkKnown={() => markLemma(token.lemma, true)}
              onMarkUnknown={() => markLemma(token.lemma, false)}
            />
          </PopoverContent>
        </Popover>
      );

      cursor = token.end;
    }

    if (cursor < analysis.paragraphText.length) {
      nodes.push(analysis.paragraphText.slice(cursor));
    }

    return <>{nodes}</>;
  };

  if (isLoading) {
    return <div className="min-h-screen bg-background text-foreground p-6">Loading reader...</div>;
  }

  if (!book) {
    return <div className="min-h-screen bg-background text-foreground p-6">No books found in your library.</div>;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className={cn(
        'fixed top-0 inset-x-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border transition-transform duration-300',
        headerVisible ? 'translate-y-0' : '-translate-y-full'
      )}>
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground" data-testid="button-back-library">
              <ChevronLeft size={18} /><span className="hidden sm:inline">Library</span>
            </Button>
          </Link>
          <div className="font-serif text-sm font-medium text-muted-foreground hidden md:block">
            {book.title} — Chapter {book.currentChapter}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon"
              onClick={() => setAssistanceEnabled(!assistanceEnabled)}
              className={cn('text-muted-foreground transition-colors', assistanceEnabled && 'text-primary bg-primary/10')}
              aria-label="Toggle vocabulary assistance" data-testid="button-toggle-assistance">
              {assistanceEnabled ? <Eye size={18} /> : <EyeOff size={18} />}
            </Button>
            <Button variant="ghost" size="icon" className="text-muted-foreground" data-testid="button-bookmark">
              <Bookmark size={18} />
            </Button>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground" data-testid="button-reader-settings">
                  <Type size={18} />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[300px] sm:w-[400px] overflow-y-auto">
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
            <Button variant="ghost" size="icon" className="text-muted-foreground" data-testid="button-more-options">
              <MoreHorizontal size={18} />
            </Button>
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
          className="relative flex items-start gap-10 py-12 md:py-20"
          data-testid="reading-row"
        >
          <div className="flex-1 min-w-0 flex flex-col" data-testid="left-column">
            <h1 className="text-3xl md:text-5xl font-medium mb-12 text-center text-foreground/90 font-serif">
              {book.chapters[book.currentChapter - 1]?.title ?? `Chapter ${book.currentChapter}`}
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
              {chapterAnalysis.map((analysis, index) => (
                <p
                  key={index}
                  ref={(element) => { paraRefs.current[index] = element; }}
                  className="mb-10 text-foreground/90 reader-text"
                  data-testid={`paragraph-${index}`}
                >
                  {renderParagraph(analysis)}
                </p>
              ))}
            </div>

            {assistanceEnabled && (
              <div className="md:hidden mt-2 space-y-10 mb-10" data-testid="mobile-cards">
                {chapterAnalysis.map((analysis, index) => {
                  if (!analysis.cardLemmas.length) return null;
                  return (
                    <div key={index} className="flex flex-col gap-3" data-testid={`mobile-card-group-${index}`}>
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
            )}

            <div className="mt-20 pt-8 border-t border-border flex justify-between items-center text-muted-foreground font-serif">
              <Button variant="ghost" className="gap-2" data-testid="button-prev-chapter" onClick={() => void updateCurrentChapter(-1)}>
                <ChevronLeft size={16} /> Previous Chapter
              </Button>
              <span className="text-sm" data-testid="text-page-info">
                Chapter {book.currentChapter} of {book.chapters.length}
              </span>
              <Button variant="ghost" className="gap-2" data-testid="button-next-chapter" onClick={() => void updateCurrentChapter(1)}>
                Next Chapter <ChevronLeft size={16} className="rotate-180" />
              </Button>
            </div>
          </div>

          <div
            className="hidden md:block relative w-[280px] flex-shrink-0"
            style={{ minHeight: 1 }}
            aria-label="Vocabulary cards"
            data-testid="card-column"
          >
            {chapterAnalysis.map((analysis, index) => {
              if (!analysis.cardLemmas.length || !assistanceEnabled) return null;
              return (
                <div
                  key={index}
                  ref={(element) => { cardGrpRefs.current[index] = element; }}
                  style={{ position: 'absolute', top: paraOffsets[index] ?? 0 }}
                  className="flex flex-col gap-3 w-full"
                  data-testid={`card-group-${index}`}
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
