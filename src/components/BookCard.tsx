import { Link } from 'wouter';
import type { BookStats, ImportedBook } from '@/core/types';
import { Progress } from './ui/progress';

interface BookCardProps {
  book: ImportedBook;
  stats: BookStats;
}

export function BookCard({ book, stats }: BookCardProps) {
  const chapterCount = book.chapters.length;
  const safeChapter = (() => {
    if (chapterCount <= 0) {
      return 0;
    }
    if (typeof book.currentChapter !== 'number' || !Number.isFinite(book.currentChapter)) {
      return 1;
    }
    const integerChapter = Math.trunc(book.currentChapter);
    if (integerChapter < 1) {
      return 1;
    }
    if (integerChapter > chapterCount) {
      return chapterCount;
    }
    return integerChapter;
  })();
  const safeProgressPercent = Number.isFinite(stats.progressPercent)
    ? stats.progressPercent
    : (chapterCount === 0 ? 0 : (safeChapter / chapterCount) * 100);

  return (
    <Link href={`/reader/${book.id}`} className="group flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-lg">
      <div className="aspect-[3/4] rounded-lg overflow-hidden border border-border bg-muted shadow-sm transition-all duration-300 group-hover:shadow-md group-hover:-translate-y-1 relative">
        <div className="w-full h-full bg-gradient-to-br from-primary/25 via-primary/10 to-background flex items-end p-2.5 sm:p-3 md:p-3 lg:p-4">
          <span className="font-serif text-sm sm:text-base md:text-base lg:text-lg text-foreground/90 line-clamp-3">{book.title}</span>
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-2.5 sm:p-3 md:p-3 lg:p-4">
          <span className="text-white text-sm font-medium">Continue reading</span>
        </div>
      </div>
      
      <div className="mt-2.5 sm:mt-3 md:mt-3 lg:mt-4 flex flex-col gap-1">
        <h3 className="font-serif font-semibold text-sm sm:text-base md:text-base lg:text-lg leading-tight text-foreground line-clamp-1 group-hover:text-primary transition-colors">
          {book.title}
        </h3>
        <p className="text-xs sm:text-xs md:text-xs lg:text-sm text-muted-foreground line-clamp-1">{book.author}</p>
      </div>

      <div className="mt-2.5 sm:mt-3 md:mt-3 lg:mt-4 space-y-1.5 sm:space-y-1.5 lg:space-y-2">
        <div className="flex justify-between items-center text-[11px] sm:text-[11px] md:text-[11px] lg:text-xs text-muted-foreground">
          <span>Chapter {safeChapter} of {chapterCount}</span>
          <span>{Math.round(safeProgressPercent)}%</span>
        </div>
        <Progress value={safeProgressPercent} className="h-1.5" />
      </div>

      <div className="mt-2 sm:mt-2.5 md:mt-2.5 lg:mt-3 flex gap-2 sm:gap-2.5 lg:gap-3 text-[11px] sm:text-[11px] md:text-[11px] lg:text-xs text-muted-foreground">
        <div className="flex flex-col">
          <span className="font-medium text-foreground text-xs sm:text-xs md:text-xs lg:text-sm">{stats.unknownTokenCount}</span>
          <span>unknown words</span>
        </div>
        <div className="w-px h-full bg-border" />
        <div className="flex flex-col">
          <span className="font-medium text-foreground text-xs sm:text-xs md:text-xs lg:text-sm">~{Math.round(stats.unknownTokenPercent)}%</span>
          <span>of text</span>
        </div>
      </div>
    </Link>
  );
}
