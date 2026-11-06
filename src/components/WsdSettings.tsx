import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import type { ReaderSettings } from '@/core/types';
import type { WsdAvailability } from '@/core/wsd-assets';
import type { WsdModelStatus } from '@/core/wsd-runtime';

interface WsdSettingsProps {
  settings: ReaderSettings;
  updateSetting: <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => void;
  availability: WsdAvailability;
  status: WsdModelStatus;
  onRetry: () => void;
}

export function WsdSettings({ settings, updateSetting, availability, status, onRetry }: WsdSettingsProps) {
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
              disabled={mode !== 'none' && !availability[mode].available}
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
