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
import { calculateBookStats } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, loadReaderSettings } from '@/core/profile-store';
import { loadVocabularyModel } from '@/core/model';
import { loadLemmaDict } from '@/core/lemma';
import type { BookStats, ImportedBook } from '@/core/types';

export default function LibraryPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const [quizOpen, setQuizOpen] = useState(false);
  const [books, setBooks] = useState<ImportedBook[]>([]);
  const [statsByBookId, setStatsByBookId] = useState<Record<string, BookStats>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fallbackStats: BookStats = useMemo(() => ({
    unknownTokenCount: 0,
    unknownTokenPercent: 0,
    progressPercent: 0,
  }), []);

  const calculateStatsForBooks = (
    loadedBooks: ImportedBook[],
    model: Awaited<ReturnType<typeof loadVocabularyModel>>,
    lemmaDict: Awaited<ReturnType<typeof loadLemmaDict>>,
  ): Record<string, BookStats> => {
    const profileState = loadProfileState();
    const activeProfile = getActiveProfile(profileState);
    const settings = loadReaderSettings();
    const nextStats: Record<string, BookStats> = {};

    for (const book of loadedBooks) {
      let stats: BookStats | null = null;
      try {
        stats = calculateBookStats(book, settings, model, activeProfile, lemmaDict, null);
      } catch (error) {
        console.warn('library-book-stats-failed', { bookId: book.id, error });
      }
      nextStats[book.id] = stats ?? fallbackStats;
    }

    return nextStats;
  };

  const refreshBooksAndStats = async () => {
    setIsLoading(true);

    try {
      await seedBooksIfEmpty([await createSeedBook()]);
      let loadedBooks = await listBooks();
      const hasLegacySeedAlice = loadedBooks.some((book) => book.id === 'seed-alice');
      const hasNewSeedHitchhiker = loadedBooks.some((book) => book.id === 'seed-hitchhiker');
      if (hasLegacySeedAlice && !hasNewSeedHitchhiker) {
        await deleteBookById('seed-alice');
        await upsertBook(await createSeedBook());
        loadedBooks = await listBooks();
      }
      setBooks(loadedBooks);

      const [model, lemmaDict] = await Promise.all([
        loadVocabularyModel(),
        loadLemmaDict(),
      ]);

      const nextStats = calculateStatsForBooks(loadedBooks, model, lemmaDict);
      setStatsByBookId(nextStats);
    } catch (error) {
      console.error('library-refresh-failed', { error });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refreshBooksAndStats();
    const unsubscribe = listenStateUpdated(() => {
      void refreshBooksAndStats();
    });
    return unsubscribe;
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
