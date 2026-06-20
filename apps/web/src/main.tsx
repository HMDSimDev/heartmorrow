import React from 'react';
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
    <RouterProvider router={router} />
  </React.StrictMode>,
);
