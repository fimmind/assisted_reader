import { Link } from 'wouter';
import type { BookStats, ImportedBook } from '@/core/types';
import { Progress } from './ui/progress';

interface BookCardProps {
  book: ImportedBook;
  stats: BookStats;
}

export function BookCard({ book, stats }: BookCardProps) {
  return (
    <Link href={`/reader/${book.id}`} className="group flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-lg">
      <div className="aspect-[3/4] rounded-lg overflow-hidden border border-border bg-muted shadow-sm transition-all duration-300 group-hover:shadow-md group-hover:-translate-y-1 relative">
        <div className="w-full h-full bg-gradient-to-br from-primary/25 via-primary/10 to-background flex items-end p-4">
          <span className="font-serif text-lg text-foreground/90 line-clamp-3">{book.title}</span>
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-4">
          <span className="text-white text-sm font-medium">Continue reading</span>
        </div>
      </div>
      
      <div className="mt-4 flex flex-col gap-1">
        <h3 className="font-serif font-semibold text-lg leading-tight text-foreground line-clamp-1 group-hover:text-primary transition-colors">
          {book.title}
        </h3>
        <p className="text-sm text-muted-foreground">{book.author}</p>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex justify-between items-center text-xs text-muted-foreground">
          <span>Chapter {book.currentChapter} of {book.chapters.length}</span>
          <span>{Math.round(stats.progressPercent)}%</span>
        </div>
        <Progress value={stats.progressPercent} className="h-1.5" />
      </div>

      <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{stats.unknownTokenCount}</span>
          <span>unknown words</span>
        </div>
        <div className="w-px h-full bg-border" />
        <div className="flex flex-col">
          <span className="font-medium text-foreground">~{Math.round(stats.unknownTokenPercent)}%</span>
          <span>of text</span>
        </div>
      </div>
    </Link>
  );
}
