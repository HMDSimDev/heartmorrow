import './i18n'; // Initialize i18next (side-effect) before any component renders.
import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { AppDataProvider } from './state/app-context';
// Nocturne type system, bundled locally (no CDN) to keep the app offline-first.
import '@fontsource-variable/fraunces';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/spline-sans-mono';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

// A single splat route renders the app shell; App keeps its own descendant
// <Routes>. A data router (createBrowserRouter) is required so useBlocker can
// warn before navigating away from an in-progress date.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AppDataProvider>
        <App />
      </AppDataProvider>
    ),
  },
]);

createRoot(container).render(
  <React.StrictMode>
    {/* Suspense covers the brief async load of a lazy locale-namespace chunk.
        With no SSR there is no server HTML to mismatch, so this is safe. */}
    <Suspense fallback={<div className="app-boot" aria-busy="true" style={{ minHeight: '100dvh' }} />}>
      <RouterProvider router={router} />
    </Suspense>
  </React.StrictMode>,
);
