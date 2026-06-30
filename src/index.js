import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ChromeProvider } from './context/ChromeContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep fetched pages warm for the whole session so navigating back is
      // instant (no "loading" flash). Mutations still call invalidateQueries,
      // so edits refresh immediately — we only stop needless re-fetches.
      staleTime: 5 * 60_000,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ChromeProvider>
            <App />
          </ChromeProvider>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
