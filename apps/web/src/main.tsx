import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { registerPwaUpdates } from './lib/pwa-update';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

registerPwaUpdates();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
