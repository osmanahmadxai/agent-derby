import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// StrictMode is deliberately not used: its double-mounted effects would open terminal
// sockets twice (starting programs twice) and call the "close race" endpoint on mount.
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
