import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, Download, Undo2 } from "lucide-react";
import {
  answerCurrentCard,
  correctCurrentCardResponse,
  getFinalizedResponses,
  isCardSessionComplete,
  revealCurrentCard,
} from "@/core/card-session";
import type { CardResponse } from "@/core/card-session";
import {
  DEFAULT_STUDY_WORD_COUNT,
  MAX_STUDY_WORD_COUNT,
  MIN_STUDY_WORD_COUNT,
} from "@/core/constants";
import type { LazyLexicon } from "@/core/lexicon";
import { createId } from "@/core/math";
import {
  getActiveProfile,
  loadProfileState,
  saveProfileState,
} from "@/core/profile-store";
import {
  analyzeStudyScope,
  calculateEstimatedCoverage,
  createAnkiStudyText,
  resolveStudyCandidates,
  sanitizeStudyExportFilename,
  selectStudyBatch,
} from "@/core/study";
import type {
  StudyCardItem,
  StudyCoverageEstimate,
  StudyCoverageItem,
  StudyTextScope,
} from "@/core/study";
import {
  addSessionToStudyState,
  appendStudyBatch,
  completeStudySession,
  createGeneratedStudySession,
  createImmediateReviewBatch,
  createStudyBatch,
  discardStudySession,
  finalizeStudyCard,
  findUnfinishedStudySession,
  getActiveStudyBatch,
  getStudySessionFirstPassResults,
  isSameStudyContext,
  undoLastStudyCard,
  updateActiveStudyCardSession,
} from "@/core/study-session";
import type {
  StudyBatch,
  StudyContextIdentity,
  StudyPersistenceState,
  StudySession,
} from "@/core/study-session";
import { loadStudyState, saveStudyState } from "@/core/study-store";
import type { ChapterAnalysisInput } from "@/core/reader-analysis";
import type { ReaderSettings, VocabularyModel } from "@/core/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardSessionScreen } from "@/components/CardSessionScreen";

interface PreparedStudy {
  requestedCount: number;
  coverageItems: StudyCoverageItem[];
  selectedItems: StudyCardItem[];
  coverage: StudyCoverageEstimate;
}

interface StudyFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookTitle: string;
  profileId: string;
  scope: StudyTextScope;
  settings: ReaderSettings;
  model: VocabularyModel;
  lemmaDict: Record<string, string>;
  lexicon: LazyLexicon;
  nlp: ChapterAnalysisInput["nlp"];
}

type StudyView = "setup" | "cards" | "completion";

function parseRequestedCount(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const count = Number(value);
  if (
    !Number.isInteger(count) ||
    count < MIN_STUDY_WORD_COUNT ||
    count > MAX_STUDY_WORD_COUNT
  ) {
    return null;
  }
  return count;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function stripTranscriptionSlashes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("/") && trimmed.endsWith("/")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function formatStudyPronunciations(values: string[]): string {
  const transcriptions = Array.from(
    new Set(
      values
        .map((value) => stripTranscriptionSlashes(value))
        .filter((value) => value.length > 0),
    ),
  );
  return transcriptions.length > 0 ? `/${transcriptions.join(", ")}/` : "";
}

function formatPartOfSpeech(value: StudyCardItem["partOfSpeech"]): string {
  if (value === null) {
    return "Part of speech unavailable";
  }
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderHighlightedSentence(item: StudyCardItem): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const span of [...item.example.targetSpans].sort(
    (left, right) => left.start - right.start,
  )) {
    nodes.push(item.example.sentence.slice(cursor, span.start));
    nodes.push(
      <mark
        key={`${span.start}-${span.end}`}
        className="rounded-sm bg-primary/15 px-0.5 text-inherit"
      >
        {item.example.sentence.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  }
  nodes.push(item.example.sentence.slice(cursor));
  return <>{nodes}</>;
}

function replaceProfile(
  profileId: string,
  nextProfile: ReturnType<typeof getActiveProfile>,
): void {
  const profileState = loadProfileState();
  if (profileState.activeProfileId !== profileId) {
    throw new Error(
      `The active profile changed while Study was open. Return to the reader and reopen Study for the active profile.`,
    );
  }
  saveProfileState({
    ...profileState,
    profiles: profileState.profiles.map((profile) =>
      profile.id === profileId ? nextProfile : profile,
    ),
  });
}

function commitStudyAndProfile(
  previousStudyState: StudyPersistenceState,
  nextStudyState: StudyPersistenceState,
  profileId: string,
  nextProfile: ReturnType<typeof getActiveProfile>,
): void {
  saveStudyState(nextStudyState);
  try {
    replaceProfile(profileId, nextProfile);
  } catch (error) {
    saveStudyState(previousStudyState);
    throw error;
  }
}

function findSession(
  state: StudyPersistenceState,
  sessionId: string,
): StudySession {
  const session = state.sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  if (!session) {
    throw new Error(`Saved Study session is missing: sessionId=${sessionId}`);
  }
  return session;
}

function downloadStudyExport(
  bookTitle: string,
  chapterIndex: number,
  items: StudyCardItem[],
): void {
  if (items.length === 0) {
    throw new RangeError("Select at least one word to export.");
  }
  const text = createAnkiStudyText(items);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeStudyExportFilename(bookTitle, chapterIndex);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface StudyExportDialogProps {
  wordsToLearn: StudyCardItem[];
  alreadyKnew: StudyCardItem[];
  onExport: (items: StudyCardItem[]) => void;
}

function StudyExportDialog({
  wordsToLearn,
  alreadyKnew,
  onExport,
}: StudyExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedLexicalItemIds, setSelectedLexicalItemIds] = useState<
    Set<string>
  >(new Set());
  const [exportErrorMessage, setExportErrorMessage] = useState("");
  const allItems = [...wordsToLearn, ...alreadyKnew];

  const openDialog = (): void => {
    setSelectedLexicalItemIds(
      new Set(wordsToLearn.map((item) => item.lexicalItemId)),
    );
    setExportErrorMessage("");
    setOpen(true);
  };

  const setItemSelected = (lexicalItemId: string, selected: boolean): void => {
    setSelectedLexicalItemIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(lexicalItemId);
      } else {
        next.delete(lexicalItemId);
      }
      return next;
    });
  };

  const exportSelectedItems = (): void => {
    const selectedItems = allItems.filter((item) =>
      selectedLexicalItemIds.has(item.lexicalItemId),
    );
    try {
      onExport(selectedItems);
      setOpen(false);
    } catch (error) {
      setExportErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to export the selected words.",
      );
    }
  };

  const groups = [
    { id: "words-to-learn", label: "Words to learn", items: wordsToLearn },
    { id: "already-knew", label: "Already knew", items: alreadyKnew },
  ];

  return (
    <>
      <Button
        variant="ghost"
        className="gap-2"
        disabled={allItems.length === 0}
        onClick={openDialog}
      >
        <Download size={16} /> Export for Anki
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setExportErrorMessage("");
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] sm:max-w-[520px] sm:rounded-sm">
          <DialogHeader>
            <DialogTitle>Export for Anki</DialogTitle>
            <DialogDescription>
              Choose the words to include to the exported file
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground" aria-live="polite">
              {selectedLexicalItemIds.size} selected
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelectedLexicalItemIds(
                    new Set(allItems.map((item) => item.lexicalItemId)),
                  )
                }
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedLexicalItemIds(new Set<string>())}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="max-h-[min(58dvh,28rem)] overflow-y-auto border-y border-border">
            {groups.map((group) =>
              group.items.length > 0 ? (
                <section key={group.id} aria-labelledby={`${group.id}-heading`}>
                  <h3
                    id={`${group.id}-heading`}
                    className="sticky top-0 bg-background px-1 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {group.label} ({group.items.length})
                  </h3>
                  <ul className="divide-y divide-border">
                    {group.items.map((item, index) => {
                      const checkboxId = `study-export-${group.id}-${index}`;
                      return (
                        <li key={item.lexicalItemId}>
                          <label
                            htmlFor={checkboxId}
                            className="flex cursor-pointer items-center gap-3 px-1 py-3"
                          >
                            <Checkbox
                              id={checkboxId}
                              checked={selectedLexicalItemIds.has(
                                item.lexicalItemId,
                              )}
                              onCheckedChange={(checked) =>
                                setItemSelected(
                                  item.lexicalItemId,
                                  checked === true,
                                )
                              }
                            />
                            <span className="min-w-0 flex-1 font-medium">
                              {item.spelling}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatPartOfSpeech(item.partOfSpeech)}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null,
            )}
          </div>

          {exportErrorMessage.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {exportErrorMessage}
            </p>
          )}

          <DialogFooter className="gap-2 sm:space-x-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={selectedLexicalItemIds.size === 0}
              onClick={exportSelectedItems}
            >
              Export selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function StudyFlow({
  open,
  onOpenChange,
  bookTitle,
  profileId,
  scope,
  settings,
  model,
  lemmaDict,
  lexicon,
  nlp,
}: StudyFlowProps) {
  const context = useMemo<StudyContextIdentity>(
    () => ({
      profileId,
      sourceDocumentId: scope.sourceDocumentId,
      chapterIndex: scope.chapterIndex,
    }),
    [profileId, scope.chapterIndex, scope.sourceDocumentId],
  );
  const [studyState, setStudyState] = useState<StudyPersistenceState | null>(
    null,
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [unfinishedSession, setUnfinishedSession] =
    useState<StudySession | null>(null);
  const [requestedCountInput, setRequestedCountInput] = useState(
    String(DEFAULT_STUDY_WORD_COUNT),
  );
  const [prepared, setPrepared] = useState<PreparedStudy | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [view, setView] = useState<StudyView>("setup");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [noMoreWords, setNoMoreWords] = useState(false);
  const preparationRunIdRef = useRef(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    try {
      const loaded = loadStudyState();
      const unfinished = findUnfinishedStudySession(loaded, context);
      setStudyState(loaded);
      setUnfinishedSession(unfinished);
      setRequestedCountInput(String(loaded.lastRequestedCount));
      setPrepared(null);
      setSessionId(null);
      setView("setup");
      setNoticeMessage("");
      setErrorMessage("");
      setNoMoreWords(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to load Study progress.",
      );
    }
  }, [context, open]);

  const requestedCount = parseRequestedCount(requestedCountInput);
  const requestedCountError =
    requestedCount === null
      ? `Enter a whole number from ${MIN_STUDY_WORD_COUNT} to ${MAX_STUDY_WORD_COUNT}.`
      : "";

  useEffect(() => {
    if (
      !open ||
      !studyState ||
      unfinishedSession ||
      requestedCount === null ||
      view !== "setup"
    ) {
      return;
    }
    const runId = preparationRunIdRef.current + 1;
    preparationRunIdRef.current = runId;
    setPreparing(true);
    setPrepared(null);
    setNoticeMessage("");
    setErrorMessage("");
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const profileState = loadProfileState();
          const profile = getActiveProfile(profileState);
          if (profile.id !== profileId) {
            throw new Error(
              "The active profile changed. Close Study and reopen it for the active profile.",
            );
          }
          const analysis = analyzeStudyScope({
            scope,
            settings,
            model,
            profile,
            lemmaDict,
            nlp,
          });
          const resolved = await resolveStudyCandidates(
            analysis.candidates,
            lexicon,
            settings.englishVariant,
          );
          if (preparationRunIdRef.current !== runId) {
            return;
          }
          const selected = selectStudyBatch(
            resolved,
            new Set<string>(),
            requestedCount,
          );
          const selectedIds = new Set(
            selected.map((item) => item.lexicalItemId),
          );
          setPrepared({
            requestedCount,
            coverageItems: analysis.coverageItems,
            selectedItems: selected,
            coverage: calculateEstimatedCoverage(
              analysis.coverageItems,
              selectedIds,
            ),
          });
          if (selected.length > 0 && selected.length < requestedCount) {
            setNoticeMessage(`${selected.length} suitable words found`);
          }
        } catch (error) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Chapter preparation failed.",
          );
        } finally {
          if (preparationRunIdRef.current === runId) {
            setPreparing(false);
          }
        }
      })();
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [
    context,
    lemmaDict,
    lexicon,
    model,
    nlp,
    open,
    profileId,
    requestedCount,
    scope,
    settings,
    studyState,
    unfinishedSession,
    view,
  ]);

  const persistState = (nextState: StudyPersistenceState): void => {
    saveStudyState(nextState);
    setStudyState(nextState);
  };

  const beginPreparedSession = (): void => {
    if (!studyState || !prepared || prepared.selectedItems.length === 0) {
      return;
    }
    try {
      const timestamp = new Date().toISOString();
      const session = createGeneratedStudySession(
        context,
        scope,
        prepared.requestedCount,
        prepared.selectedItems,
        prepared.coverageItems,
        timestamp,
      );
      const nextState = addSessionToStudyState(
        studyState,
        session,
        prepared.requestedCount,
      );
      persistState(nextState);
      setSessionId(session.id);
      setView("cards");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to start Study.",
      );
    }
  };

  const resumeSession = (): void => {
    if (!studyState || !unfinishedSession) {
      return;
    }
    if (!isSameStudyContext(context, unfinishedSession)) {
      setErrorMessage(
        "This saved session belongs to another profile, book, or chapter.",
      );
      return;
    }
    const batch = getActiveStudyBatch(unfinishedSession);
    setSessionId(unfinishedSession.id);
    setView(isCardSessionComplete(batch.cardSession) ? "completion" : "cards");
    setErrorMessage("");
  };

  const discardAndPrepare = (): void => {
    if (!studyState || !unfinishedSession) {
      return;
    }
    try {
      const nextState = discardStudySession(studyState, unfinishedSession.id);
      persistState(nextState);
      setUnfinishedSession(null);
      setSessionId(null);
      setPrepared(null);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to discard the saved session.",
      );
    }
  };

  const currentSession =
    studyState && sessionId ? findSession(studyState, sessionId) : null;
  const currentBatch = currentSession
    ? getActiveStudyBatch(currentSession)
    : null;

  const revealCard = (): void => {
    if (!studyState || !currentSession || !currentBatch) {
      return;
    }
    try {
      const nextCardSession = revealCurrentCard(currentBatch.cardSession);
      const nextState = updateActiveStudyCardSession(
        studyState,
        currentSession.id,
        nextCardSession,
        new Date().toISOString(),
      );
      persistState(nextState);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to reveal the card.",
      );
    }
  };

  const recalculateCoverage = async (session: StudySession): Promise<void> => {
    try {
      const profile = getActiveProfile(loadProfileState());
      const analysis = analyzeStudyScope({
        scope: session.textScope,
        settings,
        model,
        profile,
        lemmaDict,
        nlp,
      });
      setPrepared({
        requestedCount: session.requestedCount,
        coverageItems: analysis.coverageItems,
        selectedItems: [],
        coverage: calculateEstimatedCoverage(
          analysis.coverageItems,
          new Set<string>(),
        ),
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to update the coverage estimate.",
      );
    }
  };

  const respondAndFinalize = (response: CardResponse): void => {
    if (!studyState || !currentSession || !currentBatch) {
      return;
    }
    try {
      const itemId =
        currentBatch.cardSession.orderedItemIds[
          currentBatch.cardSession.currentPosition
        ];
      const interaction = itemId
        ? currentBatch.cardSession.items[itemId]
        : null;
      if (!interaction?.revealed) {
        throw new Error("Reveal the Study card before recording a response.");
      }
      const answeredCardSession =
        interaction.initialResponse === null
          ? answerCurrentCard(currentBatch.cardSession, response)
          : correctCurrentCardResponse(currentBatch.cardSession, response);
      const answeredState = updateActiveStudyCardSession(
        studyState,
        currentSession.id,
        answeredCardSession,
        new Date().toISOString(),
      );
      const profileState = loadProfileState();
      const profile = getActiveProfile(profileState);
      const result = finalizeStudyCard(
        answeredState,
        profile,
        currentSession.id,
        new Date().toISOString(),
        createId("study-observation"),
      );
      commitStudyAndProfile(
        studyState,
        result.studyState,
        profileId,
        result.profile,
      );
      setStudyState(result.studyState);
      setErrorMessage("");
      const nextSession = findSession(result.studyState, currentSession.id);
      const nextBatch = getActiveStudyBatch(nextSession);
      if (isCardSessionComplete(nextBatch.cardSession)) {
        setView("completion");
        if (nextBatch.kind === "first-pass") {
          setPrepared(null);
          void recalculateCoverage(nextSession);
        }
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to record the Study response.",
      );
    }
  };

  const undo = (): void => {
    if (!studyState || !currentSession) {
      return;
    }
    try {
      const profile = getActiveProfile(loadProfileState());
      const result = undoLastStudyCard(
        studyState,
        profile,
        currentSession.id,
        new Date().toISOString(),
      );
      commitStudyAndProfile(
        studyState,
        result.studyState,
        profileId,
        result.profile,
      );
      setStudyState(result.studyState);
      setView("cards");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to undo the last Study card.",
      );
    }
  };

  const startReviewMissed = (): void => {
    if (!studyState || !currentSession || !currentBatch) {
      return;
    }
    try {
      const firstPassBatchId =
        currentBatch.kind === "first-pass"
          ? currentBatch.id
          : currentBatch.firstPassBatchId;
      if (firstPassBatchId === null) {
        throw new Error(
          "This review is not linked to a completed Study batch.",
        );
      }
      const reviewBatch = createImmediateReviewBatch(
        currentSession,
        firstPassBatchId,
        createId("study-batch"),
      );
      const nextState = appendStudyBatch(
        studyState,
        currentSession.id,
        reviewBatch,
        new Date().toISOString(),
      );
      persistState(nextState);
      setView("cards");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to start the review.",
      );
    }
  };

  const learnMoreWords = async (): Promise<void> => {
    if (!studyState || !currentSession) {
      return;
    }
    setPreparing(true);
    setErrorMessage("");
    try {
      const profile = getActiveProfile(loadProfileState());
      const analysis = analyzeStudyScope({
        scope: currentSession.textScope,
        settings,
        model,
        profile,
        lemmaDict,
        nlp,
      });
      const resolved = await resolveStudyCandidates(
        analysis.candidates,
        lexicon,
        settings.englishVariant,
      );
      const excluded = new Set(currentSession.presentedLexicalItemIds);
      const items = selectStudyBatch(
        resolved,
        excluded,
        currentSession.requestedCount,
      );
      if (items.length === 0) {
        setNoMoreWords(true);
        return;
      }
      const batch = createStudyBatch(
        createId("study-batch"),
        "first-pass",
        null,
        items,
      );
      const nextState = appendStudyBatch(
        studyState,
        currentSession.id,
        batch,
        new Date().toISOString(),
      );
      persistState(nextState);
      setNoticeMessage(
        items.length < currentSession.requestedCount
          ? `${items.length} suitable words found`
          : "",
      );
      setNoMoreWords(false);
      setView("cards");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to find more words.",
      );
    } finally {
      setPreparing(false);
    }
  };

  const continueReading = (): void => {
    try {
      if (studyState && currentSession) {
        const nextState = completeStudySession(
          studyState,
          currentSession.id,
          new Date().toISOString(),
        );
        persistState(nextState);
      }
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to finish the Study session.",
      );
    }
  };

  if (!open) {
    return null;
  }

  if (view === "setup") {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-[500px] sm:rounded-sm"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="text-xl font-medium">
              New words for this chapter
            </DialogTitle>
            <DialogDescription className="sr-only">
              Choose how many new words to study from this chapter.
            </DialogDescription>
          </DialogHeader>

          {unfinishedSession ? (
            <div className="space-y-5 pb-0 pt-3">
              <p className="text-sm text-muted-foreground">
                An unfinished session is saved for this profile and chapter.
              </p>
              <div className="flex flex-wrap justify-end gap-2 pt-3">
                <Button
                  variant="outline"
                  className="rounded-sm"
                  onClick={discardAndPrepare}
                >
                  Discard and start over
                </Button>
                <Button
                  variant="outline"
                  className="rounded-sm"
                  onClick={resumeSession}
                >
                  Resume session
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 pb-0 pt-3">
              <div className="space-y-2">
                <Label htmlFor="study-word-count">Number of new words</Label>
                <Input
                  id="study-word-count"
                  type="number"
                  min={MIN_STUDY_WORD_COUNT}
                  max={MAX_STUDY_WORD_COUNT}
                  value={requestedCountInput}
                  className="rounded-sm"
                  aria-invalid={requestedCountError.length > 0}
                  aria-describedby={
                    requestedCountError.length > 0
                      ? "study-word-count-error"
                      : undefined
                  }
                  onChange={(event) => {
                    preparationRunIdRef.current += 1;
                    setRequestedCountInput(event.target.value);
                    setPreparing(false);
                    setPrepared(null);
                    setNoticeMessage("");
                    setErrorMessage("");
                  }}
                />
                {requestedCountError.length > 0 && (
                  <p
                    id="study-word-count-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {requestedCountError}
                  </p>
                )}
                <div className="flex min-h-5 items-center justify-between gap-4 text-sm">
                  {preparing ? (
                    <p className="text-muted-foreground">
                      Preparing chapter vocabulary and definitions…
                    </p>
                  ) : prepared && prepared.selectedItems.length > 0 ? (
                    <>
                      <span className="text-muted-foreground">
                        Estimated coverage
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatPercent(prepared.coverage.before)} →{" "}
                        {formatPercent(prepared.coverage.projectedAfter)}
                      </span>
                    </>
                  ) : prepared ? (
                    <p className="text-muted-foreground">
                      No new suitable words remain in this chapter.
                    </p>
                  ) : null}
                </div>
              </div>

              {noticeMessage.length > 0 && (
                <p className="text-sm text-muted-foreground">{noticeMessage}</p>
              )}
              {errorMessage.length > 0 && (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage}
                </p>
              )}

              {prepared && prepared.selectedItems.length === 0 ? (
                <div className="flex flex-wrap justify-end gap-2 pt-3">
                  <Button
                    variant="outline"
                    className="rounded-sm"
                    onClick={() => onOpenChange(false)}
                  >
                    Return to reading
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap justify-end gap-2 pt-3">
                  <Button
                    variant="outline"
                    className="rounded-sm"
                    onClick={beginPreparedSession}
                    disabled={
                      preparing ||
                      requestedCount === null ||
                      !prepared ||
                      prepared.selectedItems.length === 0
                    }
                  >
                    Start studying
                  </Button>
                </div>
              )}
            </div>
          )}
          {unfinishedSession && errorMessage.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  if (!currentSession || !currentBatch) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-md space-y-4 text-center">
          <p>
            {errorMessage || "The active Study session could not be restored."}
          </p>
          <Button onClick={() => onOpenChange(false)}>Return to reading</Button>
        </div>
      </div>
    );
  }

  if (view === "cards") {
    const itemId =
      currentBatch.cardSession.orderedItemIds[
        currentBatch.cardSession.currentPosition
      ];
    const item = currentBatch.items.find(
      (candidate) => candidate.lexicalItemId === itemId,
    );
    const interaction = itemId ? currentBatch.cardSession.items[itemId] : null;
    if (!item || !interaction) {
      return null;
    }
    const definitions = item.definitions ?? [item.definition];
    const pronunciation = formatStudyPronunciations([
      item.preferredTranscription,
      ...item.alternativeTranscriptions,
    ]);
    return (
      <CardSessionScreen
        title={currentBatch.kind === "first-pass" ? "Study" : "Review missed"}
        position={currentBatch.cardSession.currentPosition}
        total={currentBatch.items.length}
        interaction={interaction}
        frontContent={
          <div className="space-y-6 text-center">
            <div>
              <h1 className="font-serif text-3xl font-medium sm:text-4xl">
                {item.spelling}
              </h1>
              <p className="mt-2 text-[0.75em] font-medium uppercase tracking-wide text-primary">
                {formatPartOfSpeech(item.partOfSpeech)}
              </p>
            </div>
            <p className="font-serif text-base leading-relaxed text-foreground/70 sm:text-lg">
              {renderHighlightedSentence(item)}
            </p>
          </div>
        }
        revealContent={
          <div className="space-y-2 text-left">
            {pronunciation.length > 0 && (
              <div className="text-center text-muted-foreground">
                <p className="text-base">{pronunciation}</p>
              </div>
            )}
            <div className="mx-auto w-full max-w-prose text-center">
              {definitions.length === 1 ? (
                <p className="leading-relaxed">{item.definition}</p>
              ) : (
                <ol className="list-inside list-decimal space-y-2 leading-relaxed">
                  {definitions.map((definition) => (
                    <li key={definition}>{definition}</li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        }
        canUndo={currentSession.lastUndo !== null}
        errorMessage={errorMessage}
        onExit={() => onOpenChange(false)}
        onReveal={revealCard}
        onRespond={respondAndFinalize}
        onUndo={undo}
      />
    );
  }

  const { wordsToLearn, alreadyKnew } =
    getStudySessionFirstPassResults(currentSession);
  const reviewSourceBatchId =
    currentBatch.kind === "first-pass"
      ? currentBatch.id
      : currentBatch.firstPassBatchId;
  const reviewSourceBatch = currentSession.batches.find(
    (batch) => batch.id === reviewSourceBatchId && batch.kind === "first-pass",
  );
  const reviewSourceResponses = reviewSourceBatch
    ? getFinalizedResponses(reviewSourceBatch.cardSession)
    : {};
  const canReviewMissed =
    reviewSourceBatch?.items.some(
      (item) => reviewSourceResponses[item.lexicalItemId] === "unknown",
    ) ?? false;
  const isStandaloneReview = currentBatch.kind === "immediate-review";

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) continueReading();
      }}
    >
      <DialogContent className="inset-0 left-0 top-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto border-0 p-0 shadow-none sm:rounded-none [&>button]:hidden">
        <header className="border-b border-border">
          <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-2 text-muted-foreground"
              onClick={continueReading}
            >
              <ChevronLeft size={18} /> Reader
            </Button>
            <DialogTitle className="text-sm font-medium">
              {isStandaloneReview ? "Review complete" : "Batch complete"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Review the completed vocabulary batch and choose what to do next.
            </DialogDescription>
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 gap-2 text-muted-foreground"
              onClick={undo}
              disabled={currentSession.lastUndo === null}
            >
              <Undo2 size={16} />
              <span className="hidden sm:inline">Undo</span>
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
          <div className="space-y-2 text-center">
            <h1 className="font-serif text-3xl font-medium">
              {isStandaloneReview ? "Review complete" : "Chapter vocabulary"}
            </h1>
            {isStandaloneReview ? (
              <p className="text-sm text-muted-foreground">
                Review responses were saved without changing the learner
                estimate.
              </p>
            ) : prepared ? (
              <p className="text-sm text-muted-foreground">
                Updated estimated coverage:{" "}
                {formatPercent(prepared.coverage.before)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Updating the chapter coverage estimate…
              </p>
            )}
          </div>

          <div className="grid gap-8 sm:grid-cols-2">
            <section aria-labelledby="words-to-learn-heading">
              <h2
                id="words-to-learn-heading"
                className="font-serif text-xl font-medium"
              >
                Words to learn ({wordsToLearn.length})
              </h2>
              <ul className="mt-3 divide-y divide-border border-y border-border">
                {wordsToLearn.map((item) => (
                  <li
                    key={item.lexicalItemId}
                    className="flex items-baseline justify-between gap-4 py-3"
                  >
                    <span className="font-medium">{item.spelling}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatPartOfSpeech(item.partOfSpeech)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="already-knew-heading">
              <h2
                id="already-knew-heading"
                className="font-serif text-xl font-medium"
              >
                Already knew ({alreadyKnew.length})
              </h2>
              <ul className="mt-3 divide-y divide-border border-y border-border">
                {alreadyKnew.map((item) => (
                  <li
                    key={item.lexicalItemId}
                    className="flex items-baseline justify-between gap-4 py-3"
                  >
                    <span className="font-medium">{item.spelling}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatPartOfSpeech(item.partOfSpeech)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {noticeMessage.length > 0 && (
            <p className="text-sm text-muted-foreground">{noticeMessage}</p>
          )}
          {noMoreWords && (
            <p className="text-sm text-muted-foreground">
              No new suitable words remain in this chapter.
            </p>
          )}
          {errorMessage.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:flex-wrap">
            <Button
              className="sm:order-last sm:ml-auto"
              onClick={continueReading}
            >
              Continue reading
            </Button>
            {canReviewMissed && (
              <Button variant="outline" onClick={startReviewMissed}>
                Review missed
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void learnMoreWords()}
              disabled={preparing || noMoreWords}
            >
              {preparing ? "Preparing…" : "Learn more words"}
            </Button>
            <StudyExportDialog
              wordsToLearn={wordsToLearn}
              alreadyKnew={alreadyKnew}
              onExport={(items) =>
                downloadStudyExport(bookTitle, scope.chapterIndex, items)
              }
            />
          </div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
