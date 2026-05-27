import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ChevronLeft, Trash2, Upload, Download, Plus, RotateCcw } from 'lucide-react';
import { useTheme } from '../components/ThemeProvider';
import { useSettings } from '../hooks/useSettings';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { createProfile, deleteProfile, listenStateUpdated, loadProfileState, resetProfileObservations, setActiveProfile } from '@/core/profile-store';
import type { UserProfile } from '@/core/types';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { settings, updateSetting } = useSettings();
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>('');

  const refreshProfiles = () => {
    const state = loadProfileState();
    setProfiles(state.profiles);
    setActiveProfileId(state.activeProfileId);
  };

  useEffect(() => {
    refreshProfiles();
    const unsubscribe = listenStateUpdated(() => {
      refreshProfiles();
    });
    return unsubscribe;
  }, []);

  const createNewProfile = () => {
    const name = window.prompt('Profile name');
    if (!name) {
      return;
    }
    createProfile(name);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="container max-w-3xl mx-auto px-4 h-14 flex items-center">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground -ml-2">
              <ChevronLeft size={18} />
              <span>Library</span>
            </Button>
          </Link>
          <h1 className="font-serif text-lg font-medium mx-auto -translate-x-6">Settings</h1>
        </div>
      </header>

      <main className="container max-w-3xl mx-auto px-4 py-8 space-y-12">
        <section className="space-y-6">
          <div>
            <h2 className="text-xl font-serif font-medium">Profiles</h2>
            <p className="text-sm text-muted-foreground mt-1">Manage who is reading and their progress.</p>
          </div>

          <div className="space-y-4">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                className={`w-full text-left flex items-center justify-between p-4 rounded-lg border ${activeProfileId === profile.id ? 'border-primary bg-primary/5' : 'border-border bg-card'}`}
                onClick={() => setActiveProfile(profile.id)}
                type="button"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center font-serif text-lg text-secondary-foreground">
                    {profile.name[0]}
                  </div>
                  <div>
                    <p className="font-medium">{profile.name}</p>
                    {activeProfileId === profile.id && <span className="text-xs text-primary font-medium">Active</span>}
                  </div>
                </div>
                <div className="flex gap-2" onClick={(event) => event.stopPropagation()}>
                  {profiles.length > 1 && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10">
                          <Trash2 size={16} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete profile?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete the profile "{profile.name}" and all saved vocabulary observations.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteProfile(profile.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </button>
            ))}

            <div className="flex gap-3">
              <Button variant="outline" className="gap-2" onClick={createNewProfile}>
                <Plus size={16} /> New Profile
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="gap-2" disabled={profiles.length === 0}>
                    <RotateCcw size={16} /> Reset
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Reset active profile?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will clear all known/unknown quiz answers and vocabulary observations for the active profile.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => resetProfileObservations(activeProfileId)}>
                      Reset
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button variant="outline" className="gap-2" disabled>
                <Upload size={16} /> Import
              </Button>
              <Button variant="outline" className="gap-2" disabled>
                <Download size={16} /> Export
              </Button>
            </div>
          </div>
        </section>

        <Separator />

        <section className="space-y-6">
          <div>
            <h2 className="text-xl font-serif font-medium">Vocabulary Assistance</h2>
            <p className="text-sm text-muted-foreground mt-1">Control how intrusive the inline help is.</p>
          </div>

          <div className="space-y-4 max-w-md">
            <div className="flex justify-between">
              <Label>Max highlighted words per paragraph</Label>
              <span className="text-muted-foreground text-sm font-medium">{settings.maxWordsPerParagraph}</span>
            </div>
            <Slider
              value={[settings.maxWordsPerParagraph]}
              min={1}
              max={5}
              step={1}
              onValueChange={([value]) => updateSetting('maxWordsPerParagraph', value)}
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              Higher numbers provide more immediate help, but can clutter the page and distract from reading flow.
            </p>
          </div>
        </section>

        <Separator />

        <section className="space-y-6">
          <div>
            <h2 className="text-xl font-serif font-medium">Appearance</h2>
            <p className="text-sm text-muted-foreground mt-1">Customize the app interface.</p>
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <Label>Theme</Label>
              <div className="flex flex-wrap gap-3">
                {(['light', 'dark', 'system'] as const).map((themeOption) => (
                  <Button
                    key={themeOption}
                    variant={theme === themeOption ? 'default' : 'outline'}
                    onClick={() => setTheme(themeOption)}
                    className="capitalize min-w-[100px]"
                  >
                    {themeOption}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <Separator />

        <section className="space-y-4 pb-12">
          <h2 className="text-xl font-serif font-medium">About</h2>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>Easeword v1.0.0</p>
            <p>A quiet, elegant reading companion for non-native English speakers.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
