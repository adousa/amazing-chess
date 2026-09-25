import { API_BASE } from './api/client';
import { useHashPath } from './util';
import { MatchesPage } from './pages/MatchesPage';
import { MatchPage } from './pages/MatchPage';
import { LadderPage } from './pages/LadderPage';
import { StatsPage } from './pages/StatsPage';

export function App() {
  const path = useHashPath();
  const m = path.match(/^\/matches\/([^/]+)$/);
  let page;
  if (m) page = <MatchPage key={m[1]} id={decodeURIComponent(m[1])} />;
  else if (path.startsWith('/ladder')) page = <LadderPage />;
  else if (path.startsWith('/stats')) page = <StatsPage />;
  else page = <MatchesPage />;
  const nav = (href: string, label: string) => (
    <a href={`#${href}`} className={path.startsWith(href) ? 'active' : ''}>
      {label}
    </a>
  );
  return (
    <>
      <header>
        <b>Amazing Chess</b>
        {nav('/matches', 'Matches')}
        {nav('/ladder', 'Ladder')}
        {nav('/stats', 'Stats')}
        <span className="muted">API: {API_BASE}</span>
      </header>
      <main>{page}</main>
    </>
  );
}
