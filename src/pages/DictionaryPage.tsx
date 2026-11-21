import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { searchDictionary } from '@/core/dictionary-search';

type SearchState =
  | { status: 'loading' }
  | { status: 'ready'; entries: Awaited<ReturnType<typeof searchDictionary>>; query: string }
  | { status: 'error' };

type DictionaryEntry = Awaited<ReturnType<typeof searchDictionary>>[number];

function DictionarySenseResult({ sense, word }: { sense: DictionaryEntry['senses'][number]; word: string }) {
  const [expanded, setExpanded] = useState(false);
  const definitionsId = useId();
  const definitions = expanded ? sense.definitions : sense.definitions.slice(0, 3);

  return (
    <section className="py-3">
      <h3 className="mb-1 text-sm text-muted-foreground">{sense.partOfSpeech} · {sense.source}</h3>
      <ol id={definitionsId} className="list-decimal space-y-1 pl-5 leading-relaxed marker:text-muted-foreground">
        {definitions.map((definition, index) => (
          <li key={index}>{definition}</li>
        ))}
      </ol>
      {sense.definitions.length > 3 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={definitionsId}
          className="mt-1 py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less...' : 'Show more...'}
          <span className="sr-only"> for {word}, {sense.partOfSpeech}, {sense.source}</span>
        </button>
      )}
    </section>
  );
}

function DictionaryEntryResult({ entry }: { entry: DictionaryEntry }) {
  return (
    <article className="pt-6 pb-3 break-words">
      <h2 className="font-serif text-2xl font-medium">{entry.word}</h2>
      <div className="mt-2 divide-y divide-border">
        {entry.senses.map((sense) => (
          <DictionarySenseResult key={`${sense.partOfSpeech}-${sense.source}`} sense={sense} word={entry.word} />
        ))}
      </div>
    </article>
  );
}

export default function DictionaryPage() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const latestRequest = useRef(0);

  const submitSearch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const word = query.trim();
    if (!word) return;

    const request = ++latestRequest.current;
    setSearch({ status: 'loading' });
    try {
      const entries = await searchDictionary(word);
      if (request === latestRequest.current) setSearch({ status: 'ready', entries, query: word });
    } catch (error: unknown) {
      console.error('dictionary-search-failed', { word, error });
      if (request === latestRequest.current) setSearch({ status: 'error' });
    }
  };

  const entries = search?.status === 'ready' ? search.entries : [];

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto grid h-14 max-w-3xl grid-cols-[1fr_auto_1fr] items-center px-4">
          <Button asChild variant="ghost" size="sm" className="-ml-2 justify-self-start text-muted-foreground hover:text-foreground">
            <Link href="/">
              <ChevronLeft size={18} />
              Library
            </Link>
          </Button>
          <h1 className="font-serif text-lg font-medium">Dictionary</h1>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
        <form role="search" className="flex gap-2" onSubmit={submitSearch}>
          <div className="relative min-w-0 flex-1">
            <Input
              ref={searchInput}
              type="search"
              aria-label="Search the English dictionary"
              placeholder="Search for a word"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pr-10 shadow-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear search"
                className="absolute inset-y-0 right-1 my-auto size-7 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setQuery('');
                  searchInput.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
          <Button type="submit" variant="ghost" disabled={!query.trim()}>Search</Button>
        </form>

        <div role="status" className="text-sm text-muted-foreground">
          {search?.status === 'loading' && <p className="mt-5">Searching…</p>}
          {search?.status === 'error' && <p className="mt-5">Couldn’t load definitions. Try searching again.</p>}
          {search?.status === 'ready' && entries.length === 0 && (
            <p className="mt-5 break-words">No definitions found for “{search.query}”.</p>
          )}
          {entries.length > 0 && <span className="sr-only">Definitions found for {entries.map((entry) => entry.word).join(', ')}.</span>}
        </div>

        <div className="divide-y divide-border">
          {entries.map((entry) => (
            <DictionaryEntryResult key={entry.word} entry={entry} />
          ))}
        </div>
      </main>
    </div>
  );
}
