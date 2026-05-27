import { useEffect, useState } from 'react';
import { listenStateUpdated, loadReaderSettings, saveReaderSettings } from '@/core/profile-store';
import type { ReaderSettings } from '@/core/types';

export function useSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(() => loadReaderSettings());

  useEffect(() => {
    const unsubscribe = listenStateUpdated(() => {
      setSettings(loadReaderSettings());
    });
    return unsubscribe;
  }, []);

  const updateSetting = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => {
    const next: ReaderSettings = { ...settings, [key]: value };
    setSettings(next);
    saveReaderSettings(next);
  };

  return { settings, updateSetting };
}
