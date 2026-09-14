import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@/styles/globals.css';
import { ensureInterLoaded } from '@/lib/ui/font';

void ensureInterLoaded();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
