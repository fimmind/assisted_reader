import { Switch, Route, Router as WouterRouter } from "wouter";
import { ThemeProvider } from "./components/ThemeProvider";
import LibraryPage from "./pages/LibraryPage";
import ReaderPage from "./pages/ReaderPage";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LibraryPage} />
      <Route path="/reader/:bookId" component={ReaderPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="easeword-theme">
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
    </ThemeProvider>
  );
}

export default App;
