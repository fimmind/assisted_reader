import { useEffect, useState } from 'react';
import { getActiveProfile, listenStateUpdated, loadProfileState } from '@/core/profile-store';
import type { UserProfile } from '@/core/types';

export function useActiveProfile(): UserProfile {
  const [profile, setProfile] = useState<UserProfile>(() => getActiveProfile(loadProfileState()));

  useEffect(() => listenStateUpdated(() => {
    setProfile(getActiveProfile(loadProfileState()));
  }), []);

  return profile;
}
