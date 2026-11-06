import { useEffect, useState } from 'react';
import { failedWsdAsset, loadWsdAvailability, uncheckedWsdAvailability } from '@/core/wsd-assets';
import type { FailedWsdAsset, WsdAvailability } from '@/core/wsd-assets';
import { getWsdModelStatus, subscribeWsdModelStatus } from '@/core/wsd-runtime';
import type { WsdModelStatus } from '@/core/wsd-runtime';

export interface WsdStatusState {
  wsdStatus: WsdModelStatus;
  wsdAvailability: WsdAvailability;
}

export function useWsdStatus(): WsdStatusState {
  const [wsdStatus, setWsdStatus] = useState<WsdModelStatus>(getWsdModelStatus);
  const [wsdAvailability, setWsdAvailability] = useState<WsdAvailability>(uncheckedWsdAvailability);
  const [failedAsset, setFailedAsset] = useState<FailedWsdAsset | null>(null);

  useEffect(() => subscribeWsdModelStatus(setWsdStatus), []);

  useEffect(() => {
    const failed = failedWsdAsset(wsdStatus.mode, wsdStatus.phase, wsdStatus.message);
    if (failed) setFailedAsset(failed);
  }, [wsdStatus.mode, wsdStatus.phase, wsdStatus.message]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const refresh = (): void => {
      controller?.abort();
      const active = new AbortController();
      controller = active;
      void loadWsdAvailability(failedAsset, active.signal).then((availability) => {
        if (!active.signal.aborted) setWsdAvailability(availability);
      }).catch((error: unknown) => {
        if (!active.signal.aborted) console.error('wsd-availability-check-failed', { error });
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [failedAsset]);

  return { wsdStatus, wsdAvailability };
}
