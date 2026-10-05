import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { History } from './components/History';
import { RacePage } from './components/RacePage';
import { Setup } from './components/Setup';
import { SuitePage } from './components/SuitePage';
import { useHashRoute } from './router';
import { hub, type SocketStatus } from './socket';

/** Last line of defence: a render bug in one screen must not leave a blank page. */
class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('agent-derby: render failed', error, info);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page narrow">
          <div className="empty">
            <h1>This screen hit a problem</h1>
            <p className="note error">{this.state.error.message}</p>
            <p>The race itself keeps running on the server. Reload to pick it up again.</p>
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const route = useHashRoute();
  const [status, setStatus] = useState<SocketStatus>(hub.status());

  useEffect(() => {
    hub.connect();
    setStatus(hub.status());
    return hub.onStatus(setStatus);
  }, []);

  const key = route.name === 'race' || route.name === 'suite' ? `${route.name}:${route.id}` : route.name;

  return (
    <div className={`app route-${route.name}`}>
      <header className="topbar">
        <a className="wordmark" href="#/" aria-label="Agent Derby, new race">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          agent derby
        </a>
        <nav>
          <a href="#/" className={route.name === 'setup' ? 'active' : ''}>
            New race
          </a>
          <a href="#/history" className={route.name === 'history' ? 'active' : ''}>
            Past races
          </a>
        </nav>
        <span className="grow" />
        {status === 'reconnecting' && (
          <span className="reconnecting" role="status">
            <span className="spinner" /> reconnecting…
          </span>
        )}
      </header>
      <main className="main">
        <Boundary resetKey={key}>
          {route.name === 'setup' && <Setup />}
          {route.name === 'history' && <History />}
          {route.name === 'race' && <RacePage key={route.id} raceId={route.id} />}
          {route.name === 'suite' && <SuitePage key={route.id} suiteId={route.id} />}
        </Boundary>
      </main>
    </div>
  );
}
