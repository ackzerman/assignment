import { useState } from 'react';
import ParcelForm from './components/ParcelForm';
import RoutingResult from './components/RoutingResult';
import ErrorDisplay from './components/ErrorDisplay';
import './App.css';

/**
 * App — Main application shell.
 *
 * Simple layout: form on the left, result on the right.
 * On mobile: stacked vertically.
 *
 * State is lifted here so the form, result, and error components
 * can communicate through the parent without prop drilling or
 * unnecessary state management libraries.
 */
export default function App() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function handleResult(data) {
    setResult(data);
    setError(null);
  }

  function handleError(err) {
    setError(err);
    setResult(null);
  }

  function handleClear() {
    setResult(null);
    setError(null);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Parcel Routing System</h1>
        <p className="app-subtitle">Enter parcel details to determine the routing department</p>
      </header>

      <main className="app-main">
        <div className="app-layout">
          <section className="form-section">
            <ParcelForm
              onResult={handleResult}
              onError={handleError}
              onClear={handleClear}
            />
          </section>

          <section className="result-section">
            {error && <ErrorDisplay error={error} />}
            {result && <RoutingResult result={result} />}
            {!result && !error && (
              <div className="empty-state">
                <div className="empty-state-icon">📦</div>
                <p>Enter parcel details and click <strong>Route Parcel</strong> to see the routing decision.</p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
