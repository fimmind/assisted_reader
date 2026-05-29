import { useEffect, useState } from 'react';
import { listenStateUpdated, loadReaderSettings, saveReaderSettings } from '@/core/profile-store';
import type { ReaderSettings } from '@/core/types';

function areReaderSettingsEqual(left: ReaderSettings, right: ReaderSettings): boolean {
  return (
    left.fontSize === right.fontSize
    && left.lineSpacing === right.lineSpacing
    && left.fontChoice === right.fontChoice
    && left.pageWidth === right.pageWidth
    && left.maxWordsPerParagraph === right.maxWordsPerParagraph
    && left.knowledgeThreshold === right.knowledgeThreshold
    && left.englishVariant === right.englishVariant
  );
}

export function useSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(() => loadReaderSettings());

  useEffect(() => {
    const unsubscribe = listenStateUpdated(() => {
      const nextSettings = loadReaderSettings();
      setSettings((previous) =>
        areReaderSettingsEqual(previous, nextSettings) ? previous : nextSettings
      );
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
