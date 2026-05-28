import { createContext, useContext, useEffect, useState } from 'react';

type Theme = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function parseTheme(value: string | null, defaultTheme: Theme): Theme {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return defaultTheme;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "easeword-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => parseTheme(localStorage.getItem(storageKey), defaultTheme));
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === "system" ? getSystemTheme() : theme
  );

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");

      const applyTheme = () => {
        const nextTheme: ResolvedTheme = media.matches ? "dark" : "light";
        root.classList.remove("light", "dark");
        root.classList.add(nextTheme);
        setResolvedTheme(nextTheme);
      };

      applyTheme();
      media.addEventListener("change", applyTheme);
      return () => {
        media.removeEventListener("change", applyTheme);
      };
    }

    root.classList.remove("light", "dark");
    root.classList.add(theme);
    setResolvedTheme(theme);
    return undefined;
  }, [theme]);

  const value = {
    theme,
    resolvedTheme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setThemeState(theme);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");
  return context;
};
