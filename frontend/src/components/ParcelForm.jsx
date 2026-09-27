import { useState, useEffect, useRef } from 'react';
import { routeParcel, fetchCountries, isAbortError } from '../api';
import { countryName } from '../countries';

/**
 * ParcelForm — Single parcel routing form for operators.
 *
 * Design Decisions:
 * - Country dropdown is populated from the backend (single source of truth)
 * - Additional attributes are entered as key-value pairs (not raw JSON)
 * - Validation errors are displayed inline next to the relevant field
 * - The form remains usable for non-technical operators
 */

export default function ParcelForm({ onResult, onError, onClear }) {
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  // Form state
  const [weight, setWeight] = useState('');
  const [value, setValue] = useState('');
  const [destinationCountry, setDestinationCountry] = useState('');
  const [attributes, setAttributes] = useState([]);
  const [attrError, setAttrError] = useState(null);
  // In-flight request tracking: each submit gets a generation id + its own
  // AbortController. Stale completions (unmount, tab switch, replaced submit)
  // are ignored silently — never surfaced as application errors.
  const requestRef = useRef({ id: 0, controller: null });

  // Abort any in-flight submit on unmount so its late response cannot touch
  // dead state or a replaced UI.
  useEffect(() => () => {
    requestRef.current.controller?.abort();
    requestRef.current.id++;
  }, []);

  // Load country codes from backend on mount
  useEffect(() => {
    fetchCountries()
      .then(setCountries)
      .catch((err) => console.error('Failed to load countries:', err));
  }, []);

  // Add a new key-value attribute row
  function addAttribute() {
    setAttrError(null);
    setAttributes([...attributes, { key: '', value: '' }]);
  }

  // Remove an attribute row
  function removeAttribute(index) {
    setAttrError(null);
    setAttributes(attributes.filter((_, i) => i !== index));
  }

  // Update an attribute row
  function updateAttribute(index, field, val) {
    setAttrError(null);
    const updated = [...attributes];
    updated[index] = { ...updated[index], [field]: val };
    setAttributes(updated);
  }

  // Build the additionalAttributes object from key-value pairs
  function buildAdditionalAttributes() {
    const attrs = {};
    for (const attr of attributes) {
      const key = attr.key.trim();
      if (key) {
        // Try to parse as number or boolean for convenience
        let parsed = attr.value;
        if (parsed === 'true') parsed = true;
        else if (parsed === 'false') parsed = false;
        else if (parsed !== '' && !isNaN(Number(parsed))) parsed = Number(parsed);
        attrs[key] = parsed;
      }
    }
    return Object.keys(attrs).length > 0 ? attrs : undefined;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFieldErrors({});
    setAttrError(null);

    // Client-side weight guard: the backend requires weight > 0, so reject
    // non-positive input immediately with the same clear message instead of
    // a wasted round trip. (Backend remains authoritative.)
    if (weight !== '' && !(Number(weight) > 0)) {
      setFieldErrors({ weight: 'Weight must be greater than 0.' });
      return;
    }

    // Duplicate attribute keys would otherwise silently overwrite each
    // other (last-wins) with no indication to the operator. Reject up front.
    const seenKeys = new Set();
    for (const attr of attributes) {
      const key = attr.key.trim();
      if (!key) continue;
      if (seenKeys.has(key)) {
        setAttrError(`Duplicate attribute key "${key}". Keys must be unique.`);
        return;
      }
      seenKeys.add(key);
    }

    onClear();

    const requestId = ++requestRef.current.id;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current.controller = controller;
    setLoading(true);

    const parcelData = {
      weight: weight === '' ? undefined : Number(weight),
      value: value === '' ? undefined : Number(value),
      destinationCountry: destinationCountry || undefined,
      additionalAttributes: buildAdditionalAttributes(),
    };

    try {
      const result = await routeParcel(parcelData, { signal: controller.signal });
      if (requestRef.current.id !== requestId) return; // Stale: UI moved on.
      onResult(result.data);
    } catch (err) {
      if (isAbortError(err) || requestRef.current.id !== requestId) return;
      if (err.validationErrors) {
        // Map validation errors to field names for inline display
        const mapped = {};
        for (const ve of err.validationErrors) {
          mapped[ve.field] = ve.message;
        }
        setFieldErrors(mapped);
      }
      onError(err);
    } finally {
      if (requestRef.current.id === requestId) setLoading(false);
    }
  }

  function handleReset() {
    setWeight('');
    setValue('');
    setDestinationCountry('');
    setAttributes([]);
    setFieldErrors({});
    setAttrError(null);
    onClear();
  }

  return (
    <form className="parcel-form" onSubmit={handleSubmit}>
      <h2>Route a Parcel</h2>

      {/* Weight (backend requires weight > 0; no min attribute so the
          input never suggests zero is valid — the submit guard explains) */}
      <div className={`form-group ${fieldErrors.weight ? 'has-error' : ''}`}>
        <label htmlFor="parcel-weight">Weight (kg)</label>
        <input
          id="parcel-weight"
          type="number"
          step="any"
          placeholder="e.g. 2.5"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
        />
        {fieldErrors.weight && (
          <span className="field-error">{fieldErrors.weight}</span>
        )}
      </div>

      {/* Value */}
      <div className={`form-group ${fieldErrors.value ? 'has-error' : ''}`}>
        <label htmlFor="parcel-value">Value (€)</label>
        <input
          id="parcel-value"
          type="number"
          step="any"
          min="0"
          placeholder="e.g. 150.00"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {fieldErrors.value && (
          <span className="field-error">{fieldErrors.value}</span>
        )}
      </div>

      {/* Destination Country */}
      <div className={`form-group ${fieldErrors.destinationCountry ? 'has-error' : ''}`}>
        <label htmlFor="parcel-country">Destination Country</label>
        <select
          id="parcel-country"
          value={destinationCountry}
          onChange={(e) => setDestinationCountry(e.target.value)}
        >
          <option value="">— Select a country —</option>
          {countries.map((code) => (
            <option key={code} value={code}>
              {countryName(code)} ({code})
            </option>
          ))}
        </select>
        {fieldErrors.destinationCountry && (
          <span className="field-error">{fieldErrors.destinationCountry}</span>
        )}
      </div>

      {/* Additional Attributes */}
      <div className="form-group">
        <label>Additional Attributes</label>
        <div className="attributes-list">
          {attributes.map((attr, index) => (
            <div key={index} className="attribute-row">
              <input
                type="text"
                placeholder="Key (e.g. fragile)"
                value={attr.key}
                onChange={(e) => updateAttribute(index, 'key', e.target.value)}
              />
              <input
                type="text"
                placeholder="Value (e.g. true)"
                value={attr.value}
                onChange={(e) => updateAttribute(index, 'value', e.target.value)}
              />
              <button
                type="button"
                className="btn-remove-attr"
                onClick={() => removeAttribute(index)}
                title="Remove attribute"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-add-attr"
            onClick={addAttribute}
          >
            + Add Attribute
          </button>
          {attrError && (
            <span className="field-error">{attrError}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={loading}
        >
          {loading ? 'Routing…' : 'Route Parcel'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleReset}
          disabled={loading}
        >
          Clear
        </button>
      </div>
    </form>
  );
}
