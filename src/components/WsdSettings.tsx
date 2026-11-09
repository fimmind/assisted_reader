import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import type { ReaderSettings } from '@/core/types';
import type { WsdAvailability } from '@/core/wsd-assets';
import { deleteWsdModelCaches, findCachedWsdModels } from '@/core/wsd-model-cache';
import type { CachedWsdModel } from '@/core/wsd-model-cache';
import type { WsdModelStatus } from '@/core/wsd-runtime';

interface WsdSettingsProps {
  settings: ReaderSettings;
  updateSetting: <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => void;
  availability: WsdAvailability;
  status: WsdModelStatus;
  onRetry: () => void;
}

export function WsdSettings({ settings, updateSetting, availability, status, onRetry }: WsdSettingsProps) {
  const [cachedModels, setCachedModels] = useState<CachedWsdModel[]>([]);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const cacheRequest = useRef(0);

  useEffect(() => {
    if (settings.wsdMode !== 'none' || deleting) return;
    const refresh = (): void => {
      const request = ++cacheRequest.current;
      void findCachedWsdModels(globalThis.caches).then((models) => {
        if (request === cacheRequest.current) {
          setCachedModels(models);
          setCacheError((current) => current?.startsWith('Could not check downloaded models:') ? null : current);
        }
      }).catch((error: unknown) => {
        if (request === cacheRequest.current) {
          setCachedModels([]);
          setCacheError(`Could not check downloaded models: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cacheRequest.current += 1;
      window.removeEventListener('focus', refresh);
    };
  }, [settings.wsdMode, status, deleting]);

  const purge = async (models: CachedWsdModel[]): Promise<void> => {
    cacheRequest.current += 1;
    setDeleting(true);
    setCacheError(null);
    try {
      await deleteWsdModelCaches(globalThis.caches, models);
      setCachedModels(await findCachedWsdModels(globalThis.caches));
      setDialogOpen(false);
    } catch (error: unknown) {
      setCacheError(`Could not delete downloaded models: ${error instanceof Error ? error.message : String(error)}`);
      setDialogOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  const selectPurge = async (): Promise<void> => {
    cacheRequest.current += 1;
    setDeleting(true);
    setCacheError(null);
    try {
      const models = await findCachedWsdModels(globalThis.caches);
      setCachedModels(models);
      if (models.length === 1) {
        await purge(models);
      } else if (models.length > 1) {
        setDialogOpen(true);
      }
    } catch (error: unknown) {
      setCacheError(`Could not check downloaded models: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="space-y-4">
        <Label className="text-base font-medium">Word Sense Disambiguation</Label>
        <div className="flex flex-wrap gap-3" role="group" aria-label="Word Sense Disambiguation">
          {(['none', 'sayedshaun', 'glite-lens'] as const).map((mode) => (
            <Button
              key={mode}
              variant={settings.wsdMode === mode ? 'default' : 'outline'}
              aria-pressed={settings.wsdMode === mode}
              disabled={deleting || (mode !== 'none' && !availability[mode].available)}
              title={mode === 'none' ? undefined : availability[mode].reason}
              onClick={() => updateSetting('wsdMode', mode)}
              className="min-w-[100px]"
              data-testid={`button-wsd-${mode}`}
            >
              {mode === 'none' ? 'None' : mode === 'sayedshaun' ? 'Light' : 'Heavier'}
              {mode !== 'none' && availability[mode].checked && !availability[mode].available && ' (Unavailable)'}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Light uses SayedShaun WSD (DistilBERT) for faster lookups and a smaller model download. Heavier uses Glite LENS for stronger sense ranking with a larger model download.
        </p>
        {settings.wsdMode === 'none' && cachedModels.length > 0 && (
          <Button variant="outline" size="sm" disabled={deleting} onClick={() => void selectPurge()}>Purge unused models</Button>
        )}
        {settings.wsdMode === 'none' && cacheError && (
          <p className="text-xs text-destructive" role="alert">{cacheError}</p>
        )}
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!deleting) setDialogOpen(open); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Which model would you like to delete?</DialogTitle>
              <DialogDescription>Delete downloaded model data from this browser.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={deleting} onClick={() => void purge(['sayedshaun'])}>Light (SayedShaun WSD)</Button>
              <Button variant="outline" disabled={deleting} onClick={() => void purge(['glite-lens'])}>Heavier (Glite LENS)</Button>
              <Button variant="outline" disabled={deleting} onClick={() => void purge(['sayedshaun', 'glite-lens'])}>All of them</Button>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={deleting} onClick={() => setDialogOpen(false)}>Cancel</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {settings.wsdMode !== 'none' && availability[settings.wsdMode].available && (
          <div className="space-y-2" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{status.phase === 'error' ? `Model error: ${status.message}` : status.message}</span>
              {status.totalBytes > 0 && status.phase === 'downloading' && (
                <span>{Math.round(100 * status.downloadedBytes / status.totalBytes)}%</span>
              )}
            </div>
            {status.phase === 'downloading' && status.totalBytes > 0 && (
              <Progress value={100 * status.downloadedBytes / status.totalBytes} />
            )}
            {status.phase === 'error' && (
              <Button variant="outline" size="sm" onClick={onRetry}>Retry download</Button>
            )}
          </div>
        )}
      </div>
      {settings.wsdMode !== 'none' && (
        <div className="space-y-2">
          <Label className="text-base font-medium">Reduction level</Label>
          <Slider
            value={[settings.wsdReductionLevel]}
            min={0}
            max={10}
            step={1}
            onValueChange={([level]) => updateSetting('wsdReductionLevel', level)}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Retain more</span><span>Hide more</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Each model has its own single-sentence calibration. Zero retained every correct calibration sense; higher levels target 1–10% misses. Actual misses can differ, especially with more context.
          </p>
        </div>
      )}
      {settings.wsdMode !== 'none' && (
        <div className="space-y-3">
          <Label className="text-base font-medium">Context unit</Label>
          <div className="flex flex-wrap gap-3">
            {(['sentence', 'paragraph'] as const).map((unit) => (
              <Button
                key={unit}
                variant={settings.wsdContextUnit === unit ? 'default' : 'outline'}
                onClick={() => updateSetting('wsdContextUnit', unit)}
                className="min-w-[100px]"
              >
                {unit === 'sentence' ? 'Sentences' : 'Paragraphs'}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label>Context size</Label>
            <span className="text-muted-foreground text-sm font-medium">
              {settings.wsdContextSize} {settings.wsdContextUnit}{settings.wsdContextSize === 1 ? '' : 's'}
            </span>
          </div>
          <Slider
            value={[settings.wsdContextSize]}
            min={1}
            max={3}
            step={1}
            onValueChange={([size]) => updateSetting('wsdContextSize', size)}
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Includes the word’s sentence or paragraph and nearby text. More context may help or hurt and can take longer to process.
          </p>
        </div>
      )}
    </>
  );
}
