import { useState } from 'react';
import ParcelForm from './components/ParcelForm';
import RoutingResult from './components/RoutingResult';
import BatchUpload from './components/BatchUpload';
import BatchResults from './components/BatchResults';
import ErrorDisplay from './components/ErrorDisplay';
import './App.css';

/**
 * App — Main application shell.
 *
 * Phase 4 addition: Tab navigation to switch between
 * Single Parcel routing and Batch Upload.
 *
 * State is lifted here so the form, result, and error components
 * can communicate through the parent without prop drilling or
 * unnecessary state management libraries.
 */
export default function App() {
  const [activeTab, setActiveTab] = useState('single'); // 'single' | 'batch'
  const [result, setResult] = useState(null);
  const [batchResult, setBatchResult] = useState(null);
  const [error, setError] = useState(null);

  function handleResult(data) {
    setResult(data);
    setError(null);
  }

  function handleBatchResult(data) {
    setBatchResult(data);
    setError(null);
  }

  function handleError(err) {
    setError(err);
    setResult(null);
    setBatchResult(null);
  }

  function handleClear() {
    setResult(null);
    setBatchResult(null);
    setError(null);
  }

  function switchTab(tab) {
    setActiveTab(tab);
    handleClear();
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Parcel Routing System</h1>
        <p className="app-subtitle">Enter parcel details to determine the routing department</p>
      </header>

      {/* Tab Navigation */}
      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === 'single' ? 'active' : ''}`}
          onClick={() => switchTab('single')}
        >
          📦 Single Parcel
        </button>
        <button
          className={`tab-btn ${activeTab === 'batch' ? 'active' : ''}`}
          onClick={() => switchTab('batch')}
        >
          📁 Batch Upload
        </button>
      </nav>

      <main className="app-main">
        <div className="app-layout">
          {/* Left side — Form or Upload */}
          <section className="form-section">
            {activeTab === 'single' ? (
              <ParcelForm
                onResult={handleResult}
                onError={handleError}
                onClear={handleClear}
              />
            ) : (
              <BatchUpload
                onBatchResult={handleBatchResult}
                onError={handleError}
                onClear={handleClear}
              />
            )}
          </section>

          {/* Right side — Results */}
          <section className="result-section">
            {error && <ErrorDisplay error={error} />}

            {activeTab === 'single' && result && <RoutingResult result={result} />}
            {activeTab === 'batch' && batchResult && <BatchResults data={batchResult} />}

            {!result && !batchResult && !error && (
              <div className="empty-state">
                <div className="empty-state-icon">
                  {activeTab === 'single' ? '📦' : '📁'}
                </div>
                <p>
                  {activeTab === 'single'
                    ? <>Enter parcel details and click <strong>Route Parcel</strong> to see the routing decision.</>
                    : <>Upload a JSON file with parcel data to process them in bulk.</>
                  }
                </p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
