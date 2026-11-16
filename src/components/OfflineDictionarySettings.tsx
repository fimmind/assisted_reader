import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import {
  disableOfflineDictionaries,
  enableOfflineDictionaries,
  getOfflineDictionaryStatus,
  subscribeOfflineDictionaryStatus,
} from '@/core/offline-dictionaries';
import type { OfflineDictionaryStatus } from '@/core/offline-dictionaries';

const initialStatus: OfflineDictionaryStatus = {
  enabled: false,
  phase: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  message: null,
};

function statusIsBusy(status: OfflineDictionaryStatus): boolean {
  return status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'deleting';
}

function statusErrorMessage(status: OfflineDictionaryStatus): string {
  return status.message || 'Offline dictionary download failed.';
}

function statusMessage(status: OfflineDictionaryStatus): string {
  if (status.message) return status.message;
  switch (status.phase) {
    case 'idle': return 'Not downloaded.';
    case 'checking': return 'Checking dictionary download.';
    case 'downloading': return 'Downloading dictionaries.';
    case 'ready': return 'Downloaded. Dictionary lookups use local data.';
    case 'deleting': return 'Removing downloaded dictionaries.';
    case 'error': return statusErrorMessage(status);
  }
}

export function OfflineDictionarySettings() {
  const [status, setStatus] = useState<OfflineDictionaryStatus>(initialStatus);
  const [actionError, setActionError] = useState<string | null>(null);
  const operation = useRef(0);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = subscribeOfflineDictionaryStatus((nextStatus) => {
      receivedUpdate = true;
      if (active) {
        setStatus(nextStatus);
      }
    });

    void getOfflineDictionaryStatus().then((currentStatus) => {
      if (active && !receivedUpdate) {
        setStatus(currentStatus);
      }
    }).catch((error: unknown) => {
      if (active) {
        console.warn('offline-dictionaries-status-load-failed', { error });
        setActionError(`Could not load offline dictionary status: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const runAction = async (enabled: boolean): Promise<void> => {
    const currentOperation = ++operation.current;
    setActionError(null);
    try {
      if (enabled) {
        await enableOfflineDictionaries(import.meta.env.BASE_URL);
      } else {
        await disableOfflineDictionaries();
      }
    } catch (error: unknown) {
      if (currentOperation === operation.current) {
        console.warn('offline-dictionaries-action-failed', { enabled, error });
        setActionError(`Could not ${enabled ? 'download' : 'remove'} offline dictionaries: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const busy = statusIsBusy(status);
  const progress = status.totalBytes > 0
    ? Math.min(100, Math.max(0, 100 * status.downloadedBytes / status.totalBytes))
    : 0;
  const displayedError = actionError ?? (status.phase === 'error' ? statusErrorMessage(status) : null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="offline-dictionaries-switch" className="text-base font-medium">Offline dictionaries</Label>
        <Switch
          id="offline-dictionaries-switch"
          data-testid="toggle-offline-dictionaries"
          aria-label="Enable offline dictionaries"
          checked={status.enabled}
          disabled={status.phase === 'checking' || status.phase === 'deleting'}
          onCheckedChange={(enabled) => { void runAction(enabled); }}
        />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Download about 43 MiB of dictionary data for this browser. When ready, dictionary lookups use local data and make no server requests. Turning this off removes the download.
      </p>
      <div className="space-y-2" role="status" aria-live="polite" aria-busy={busy}>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{displayedError ?? statusMessage(status)}</span>
          {status.phase === 'downloading' && status.totalBytes > 0 && <span>{Math.round(progress)}%</span>}
        </div>
        {status.phase === 'downloading' && status.totalBytes > 0 && <Progress value={progress} />}
        {status.phase === 'error' && (
          <Button
            variant="outline"
            size="sm"
            data-testid="button-retry-offline-dictionaries"
            onClick={() => { void runAction(true); }}
          >
            Retry download
          </Button>
        )}
      </div>
    </div>
  );
}
