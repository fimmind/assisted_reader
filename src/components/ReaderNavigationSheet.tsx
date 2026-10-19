import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookmarkX, ChevronDown, Search } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
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
  open: boolean;
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

function navigationAncestors(entries: BookNavigationEntry[], activeId: string | null): string[] {
  if (activeId === null) return [];
  for (const entry of entries) {
    if (entry.id === activeId) return [];
    const childAncestors = navigationAncestors(entry.children, activeId);
    if (childAncestors.length > 0 || entry.children.some((child) => child.id === activeId)) {
      return [entry.id, ...childAncestors];
    }
  }
  return [];
}

function NavigationTree({ entries, activeId, open, onNavigate }: NavigationTreeProps) {
  const treeId = useId();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(navigationAncestors(entries, activeId)));
  const wasOpenRef = useRef(false);
  const toggleExpanded = (id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setExpandedIds(new Set(navigationAncestors(entries, activeId)));
  }, [activeId, entries, open]);

  return (
    <ul className="space-y-0 pt-2">
      {entries.map((entry) => (
        <NavigationTreeEntry
          key={entry.id}
          entry={entry}
          activeId={activeId}
          expandedIds={expandedIds}
          treeId={treeId}
          onToggle={toggleExpanded}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

interface NavigationTreeEntryProps {
  entry: BookNavigationEntry;
  activeId: string | null;
  expandedIds: Set<string>;
  treeId: string;
  onToggle: (id: string) => void;
  onNavigate: (location: ReaderLocation) => void;
}

function NavigationTreeEntry({ entry, activeId, expandedIds, treeId, onToggle, onNavigate }: NavigationTreeEntryProps) {
  const isExpanded = expandedIds.has(entry.id);
  const contentId = `${treeId}-children-${encodeURIComponent(entry.id)}`;
  return (
    <li>
      <div className="flex h-8 items-stretch">
        {entry.children.length > 0 && (
          <button
            type="button"
            className="flex w-8 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${entry.title}`}
            aria-expanded={isExpanded}
            aria-controls={contentId}
            onClick={() => onToggle(entry.id)}
          >
            <ChevronDown size={14} className={isExpanded ? '' : '-rotate-90'} aria-hidden="true" />
          </button>
        )}
        {entry.children.length === 0 && <span className="w-8 shrink-0" aria-hidden="true" />}
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer rounded-none px-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:font-medium aria-[current=location]:text-foreground"
          aria-current={entry.id === activeId ? 'location' : undefined}
          title={entry.title}
          data-testid={`navigation-entry-${entry.id}`}
          onClick={() => onNavigate(entry.location)}
        >
          <span className="block truncate">{entry.title}</span>
        </button>
      </div>
      {entry.children.length > 0 && (
        <ul id={contentId} className="ml-3 space-y-0" hidden={!isExpanded}>
          {entry.children.map((child) => (
            <NavigationTreeEntry key={child.id} entry={child} activeId={activeId} expandedIds={expandedIds} treeId={treeId} onToggle={onToggle} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
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
      <SheetContent side="right" showCloseButton={false} aria-describedby={undefined} className="w-[360px] max-w-full sm:w-[440px] flex flex-col gap-0 overflow-hidden p-0" data-testid="reader-navigation-sheet">
        <SheetTitle className="sr-only">Navigate book</SheetTitle>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-none">
          <TabsList className="grid w-full shrink-0 grid-cols-3 rounded-none border-b border-border bg-muted/40 p-1 shadow-sm">
            <TabsTrigger value="contents" className="rounded-none bg-transparent shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none">Contents</TabsTrigger>
            <TabsTrigger value="bookmarks" className="rounded-none bg-transparent shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none">Bookmarks</TabsTrigger>
            <TabsTrigger value="search" className="rounded-none bg-transparent shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none">Search</TabsTrigger>
          </TabsList>

          <TabsContent value="contents" className="mt-0 min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full px-4">
              {navigation.length > 0
                ? <NavigationTree entries={navigation} activeId={activeId} open={open} onNavigate={onNavigate} />
                : <p className="py-6 text-sm text-muted-foreground">This book has no table of contents.</p>}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="bookmarks" className="mt-0 min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full px-4">
              {bookmarks.length === 0
                ? <p className="py-6 text-sm text-muted-foreground">No bookmarks yet.</p>
                : <ul className="divide-y divide-border border-y border-border">{bookmarks.map((bookmark) => (
                  <li key={bookmark.id} className="flex items-center gap-2 py-2" data-testid={`bookmark-${bookmark.id}`}>
                    <button type="button" className="min-w-0 flex-1 px-1 py-1 text-left" onClick={() => onNavigate(bookmark.location)}>
                      <span className="block truncate text-sm">{bookmark.label || book.chapters[bookmark.location.chapterIndex]?.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{book.chapters[bookmark.location.chapterIndex]?.title ?? `Chapter ${bookmark.location.chapterIndex + 1}`}</span>
                    </button>
                    <Button type="button" variant="ghost" size="icon" className="rounded-none" aria-label={`Delete bookmark ${bookmark.label || bookmark.id}`}
                      onClick={() => onDeleteBookmark(bookmark.id)} data-testid={`button-delete-bookmark-${bookmark.id}`}>
                      <BookmarkX size={16} />
                    </Button>
                  </li>
                ))}</ul>}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="search" className="mt-0 min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="rounded-none pl-9 focus-visible:ring-muted-foreground/40"
                  placeholder="Search this book" aria-label="Search this book" data-testid="input-reader-search" />
              </div>
              <ScrollArea className="min-h-0 flex-1 px-4">
                {isSearching && <p role="status" className="py-3 text-sm text-muted-foreground">Searching…</p>}
                {searchError && <p role="alert" className="py-3 text-sm text-destructive">{searchError}</p>}
                {noMatches && <p className="py-3 text-sm text-muted-foreground">No matches found.</p>}
                {visibleMatches.length > 0 && <>
                  <p className="pb-2 text-xs text-muted-foreground">{hasMoreMatches ? 'Showing the first 200 of 200+ matches.' : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}</p>
                  <ul className="divide-y divide-border border-y border-border">{visibleMatches.map((match, index) => (
                    <li key={`${match.chapterIndex}:${match.paragraphIndex}:${match.startOffset}`}>
                      <button type="button" className="w-full rounded-none border-0 px-1 py-3 text-left hover:bg-muted/50"
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
