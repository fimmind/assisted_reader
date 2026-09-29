import { memo, useEffect, useRef, useState } from 'react';
import type { MouseEvent, TouchEvent } from 'react';
import { Link } from 'wouter';
import { X } from 'lucide-react';
import type { BookStats, ImportedBook } from '@/core/types';
import { Progress } from './ui/progress';
import { Spinner } from './ui/spinner';

interface BookCardProps {
  book: ImportedBook;
  stats: BookStats;
  isAnalyzing: boolean;
  analysisProgressPercent: number;
  onOpen: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function BookCardComponent({ book, stats, isAnalyzing, analysisProgressPercent, onOpen, onDelete, isDeleting }: BookCardProps) {
  const [deleteVisible, setDeleteVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const ignoreClickRef = useRef(false);
  const ignoreClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!deleteVisible) {
      return;
    }
    const dismissOnOutsidePress = (event: PointerEvent): void => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) {
        setDeleteVisible(false);
      }
    };
    document.addEventListener('pointerdown', dismissOnOutsidePress);
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePress);
  }, [deleteVisible]);

  useEffect(() => () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
    }
    if (ignoreClickTimerRef.current !== null) {
      window.clearTimeout(ignoreClickTimerRef.current);
    }
  }, []);

  const cancelPress = (): void => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressStartRef.current = null;
  };

  const onTouchStart = (event: TouchEvent<HTMLAnchorElement>): void => {
    cancelPress();
    if (event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    pressStartRef.current = { x: touch.clientX, y: touch.clientY };
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      ignoreClickRef.current = true;
      setDeleteVisible(true);
    }, 500);
  };

  const onTouchMove = (event: TouchEvent<HTMLAnchorElement>): void => {
    if (event.touches.length !== 1) {
      cancelPress();
      return;
    }
    const start = pressStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch || Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10) {
      cancelPress();
    }
  };

  const onTouchEnd = (event: TouchEvent<HTMLAnchorElement>): void => {
    cancelPress();
    if (ignoreClickRef.current) {
      event.preventDefault();
      if (ignoreClickTimerRef.current !== null) {
        window.clearTimeout(ignoreClickTimerRef.current);
      }
      ignoreClickTimerRef.current = window.setTimeout(() => {
        ignoreClickRef.current = false;
        ignoreClickTimerRef.current = null;
      }, 350);
    }
  };

  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (ignoreClickRef.current) {
      event.preventDefault();
      ignoreClickRef.current = false;
      return;
    }
    onOpen();
  };

  const onDeleteClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (ignoreClickRef.current) {
      event.preventDefault();
      ignoreClickRef.current = false;
      return;
    }
    onDelete();
  };

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
    <div ref={cardRef} className="group relative">
      <div className="pointer-events-none relative z-[1] aspect-[3/4] overflow-hidden rounded-lg border border-border bg-muted shadow-sm transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-md">
        <div className="flex h-full w-full items-end bg-gradient-to-br from-primary/25 via-primary/10 to-background p-2.5 sm:p-3 md:p-3 lg:p-4">
          <span className="font-serif text-sm sm:text-base md:text-base lg:text-lg text-foreground/90 line-clamp-3">{book.title}</span>
        </div>
        <div
          className={`absolute inset-x-0 top-0 h-1/2 transition-opacity duration-300 ease-out group-hover:opacity-100 group-focus-within:opacity-100 ${deleteVisible ? 'opacity-100' : 'opacity-0'}`}
          style={{ backgroundImage: 'linear-gradient(to bottom, hsl(220 25% 10% / 0.25), hsl(220 25% 10% / 0.1) 50%, transparent)' }}
        />
        <button
          type="button"
          aria-label={`Delete ${book.title}`}
          title={`Delete ${book.title}`}
          onClick={onDeleteClick}
          disabled={isDeleting}
          className={`absolute right-0 top-0 z-10 flex size-10 cursor-pointer items-center justify-center rounded-full text-foreground/90 transition-opacity duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:cursor-wait group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${deleteVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <X size={18} strokeWidth={2.5} aria-hidden="true" />
        </button>
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
          <span className="font-medium text-foreground text-xs sm:text-xs md:text-xs lg:text-sm inline-flex items-center gap-1">
            {stats.unknownTokenCount}
            {isAnalyzing ? (
              <>
                <Spinner className="size-3 text-muted-foreground" aria-label="Analyzing book" />
                <span className="text-[10px] text-muted-foreground">{analysisProgressPercent}%</span>
              </>
            ) : null}
          </span>
          <span>unknown words</span>
        </div>
        <div className="w-px h-full bg-border" />
        <div className="flex flex-col">
          <span className="font-medium text-foreground text-xs sm:text-xs md:text-xs lg:text-sm">~{Math.round(stats.unknownTokenPercent)}%</span>
          <span>of text</span>
        </div>
      </div>

      <Link
        href={`/reader/${book.id}`}
        onClickCapture={onLinkClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={cancelPress}
        onContextMenu={(event) => {
          if (pressStartRef.current || deleteVisible) {
            event.preventDefault();
          }
        }}
        aria-label={`Open ${book.title}`}
        className="absolute inset-0 z-0 select-none rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      />
    </div>
  );
}

export const BookCard = memo(BookCardComponent);
