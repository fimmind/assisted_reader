import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkX, Search } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { navigationForBook } from '@/core/book-navigation';
import { searchBookText } from '@/core/reader-search';
import type { ReaderSearchMatch } from '@/core/reader-search';
import type { BookNavigationEntry, ImportedBook, ReaderBookmark, ReaderLocation } from '@/core/types';

interface ReaderNavigationSheetProps {
  open: boolean;
  startOnSearch: boolean;
  onOpenChange: (open: boolean) => void;
  book: ImportedBook;
  location: ReaderLocation;
  bookmarks: ReaderBookmark[];
  onNavigate: (location: ReaderLocation) => void;
  onDeleteBookmark: (bookmarkId: string) => void;
}

interface NavigationTreeProps {
  entries: BookNavigationEntry[];
  activeId: string | null;
  onNavigate: (location: ReaderLocation) => void;
}

function flattenEntries(entries: BookNavigationEntry[]): BookNavigationEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children)]);
}

function compareLocation(left: ReaderLocation, right: ReaderLocation): number {
  if (left.chapterIndex !== right.chapterIndex) return left.chapterIndex - right.chapterIndex;
  if (left.blockIndex !== right.blockIndex) return left.blockIndex - right.blockIndex;
  return left.textOffset - right.textOffset;
}

function activeNavigationId(entries: BookNavigationEntry[], location: ReaderLocation): string | null {
  const active = flattenEntries(entries).filter((entry) => compareLocation(entry.location, location) <= 0)
    .reduce<BookNavigationEntry | null>((latest, entry) => !latest || compareLocation(entry.location, latest.location) >= 0 ? entry : latest, null);
  return active?.id ?? null;
}

function NavigationTree({ entries, activeId, onNavigate }: NavigationTreeProps) {
  return (
    <ul className="space-y-1">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:font-medium aria-[current=location]:text-foreground"
            aria-current={entry.id === activeId ? 'location' : undefined}
            data-testid={`navigation-entry-${entry.id}`}
            onClick={() => onNavigate(entry.location)}
          >
            {entry.title}
          </button>
          {entry.children.length > 0 && (
            <div className="ml-3 border-l border-border pl-2">
              <NavigationTree entries={entry.children} activeId={activeId} onNavigate={onNavigate} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function HighlightedSnippet({ snippet, query }: { snippet: string; query: string }) {
  const pieces = useMemo(() => {
    const term = query.trim();
    if (!term) return [{ text: snippet, highlighted: false }];
    const expression = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu');
    return snippet.split(expression).filter(Boolean).map((text) => ({
      text,
      highlighted: text.toLocaleLowerCase() === term.toLocaleLowerCase(),
    }));
  }, [query, snippet]);
  return <>{pieces.map((piece, index) => piece.highlighted
    ? <mark key={index} className="rounded-sm bg-primary/20 text-foreground">{piece.text}</mark>
    : <span key={index}>{piece.text}</span>)}</>;
}

function matchLabel(book: ImportedBook, match: ReaderSearchMatch): string {
  const chapter = book.chapters[match.chapterIndex];
  return `${chapter?.title ?? `Chapter ${match.chapterIndex + 1}`} · paragraph ${match.paragraphIndex + 1}`;
}

export function ReaderNavigationSheet({
  open,
  startOnSearch,
  onOpenChange,
  book,
  location,
  bookmarks,
  onNavigate,
  onDeleteBookmark,
}: ReaderNavigationSheetProps) {
  const navigation = useMemo(() => navigationForBook(book), [book]);
  const activeId = activeNavigationId(navigation, location);
  const [activeTab, setActiveTab] = useState('contents');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ReaderSearchMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [didSearch, setDidSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setActiveTab(startOnSearch ? 'search' : 'contents');
  }, [open, startOnSearch]);

  useEffect(() => {
    if (open && startOnSearch) {
      setActiveTab('search');
    }
  }, [open, startOnSearch]);

  useEffect(() => {
    if (!open || activeTab !== 'search') return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, open]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !open) {
      setMatches([]);
      setIsSearching(false);
      setSearchError(null);
      setDidSearch(false);
      return;
    }
    const controller = new AbortController();
    setMatches([]);
    setIsSearching(true);
    setSearchError(null);
    setDidSearch(true);
    void searchBookText(book, normalizedQuery, {
      maxResults: 201,
      signal: controller.signal,
      contextCharacters: 52,
    }).then((results) => {
      if (controller.signal.aborted) return;
      setMatches(results);
      setIsSearching(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.error('reader-search-failed', { bookId: book.id, query: normalizedQuery, error });
      setSearchError('Search could not be completed. Try a shorter query.');
      setIsSearching(false);
    });
    return () => controller.abort();
  }, [book, open, query]);

  const visibleMatches = matches.slice(0, 200);
  const hasMoreMatches = matches.length > 200;
  const noMatches = didSearch && !isSearching && matches.length === 0 && !searchError;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" aria-describedby={undefined} className="w-[360px] max-w-full sm:w-[440px] flex flex-col gap-4 overflow-hidden" data-testid="reader-navigation-sheet">
        <SheetHeader>
          <SheetTitle className="font-serif">Navigate book</SheetTitle>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="contents">Contents</TabsTrigger>
            <TabsTrigger value="bookmarks">Bookmarks</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
          </TabsList>

          <TabsContent value="contents" className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-4">
              {navigation.length > 0
                ? <NavigationTree entries={navigation} activeId={activeId} onNavigate={onNavigate} />
                : <p className="py-6 text-sm text-muted-foreground">This book has no table of contents.</p>}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="bookmarks" className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-4">
              {bookmarks.length === 0
                ? <p className="py-6 text-sm text-muted-foreground">No bookmarks yet.</p>
                : <ul className="space-y-2">{bookmarks.map((bookmark) => (
                  <li key={bookmark.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2" data-testid={`bookmark-${bookmark.id}`}>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onNavigate(bookmark.location)}>
                      <span className="block truncate text-sm">{bookmark.label || book.chapters[bookmark.location.chapterIndex]?.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{book.chapters[bookmark.location.chapterIndex]?.title ?? `Chapter ${bookmark.location.chapterIndex + 1}`}</span>
                    </button>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Delete bookmark ${bookmark.label || bookmark.id}`}
                      onClick={() => onDeleteBookmark(bookmark.id)} data-testid={`button-delete-bookmark-${bookmark.id}`}>
                      <BookmarkX size={16} />
                    </Button>
                  </li>
                ))}</ul>}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="search" className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="pl-9"
                  placeholder="Search this book" aria-label="Search this book" data-testid="input-reader-search" />
              </div>
              <ScrollArea className="min-h-0 flex-1 pr-4">
                {isSearching && <p role="status" className="py-3 text-sm text-muted-foreground">Searching…</p>}
                {searchError && <p role="alert" className="py-3 text-sm text-destructive">{searchError}</p>}
                {noMatches && <p className="py-3 text-sm text-muted-foreground">No matches found.</p>}
                {visibleMatches.length > 0 && <>
                  <p className="pb-2 text-xs text-muted-foreground">{hasMoreMatches ? 'Showing the first 200 of 200+ matches.' : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}</p>
                  <ul className="space-y-2">{visibleMatches.map((match, index) => (
                    <li key={`${match.chapterIndex}:${match.paragraphIndex}:${match.startOffset}`}>
                      <button type="button" className="w-full rounded-md border border-border p-3 text-left hover:bg-muted"
                        onClick={() => onNavigate(match.location)} data-testid={`reader-search-result-${index}`}>
                        <span className="mb-1 block text-xs text-muted-foreground">{matchLabel(book, match)}</span>
                        <span className="text-sm leading-relaxed">{match.snippetStartOffset > 0 ? '…' : ''}<HighlightedSnippet snippet={match.snippet} query={query} />{match.snippetStartOffset + match.snippet.length < (book.chapters[match.chapterIndex]?.paragraphs[match.paragraphIndex]?.length ?? 0) ? '…' : ''}</span>
                      </button>
                    </li>
                  ))}</ul>
                </>}
              </ScrollArea>
            </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
