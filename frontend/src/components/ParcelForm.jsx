import { useState, useEffect } from 'react';
import { routeParcel, fetchCountries } from '../api';

/**
 * ParcelForm — Single parcel routing form for operators.
 *
 * Design Decisions:
 * - Country dropdown is populated from the backend (single source of truth)
 * - Additional attributes are entered as key-value pairs (not raw JSON)
 * - Validation errors are displayed inline next to the relevant field
 * - The form remains usable for non-technical operators
 */

// Map of country codes to display names for the dropdown
const COUNTRY_NAMES = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia',
  CY: 'Cyprus', CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia',
  FI: 'Finland', FR: 'France', DE: 'Germany', GR: 'Greece',
  HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LV: 'Latvia',
  LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands',
  PL: 'Poland', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia',
  SI: 'Slovenia', ES: 'Spain', SE: 'Sweden', GB: 'United Kingdom',
  US: 'United States', CA: 'Canada', AU: 'Australia', JP: 'Japan',
  CN: 'China', IN: 'India', BR: 'Brazil', MX: 'Mexico', KR: 'South Korea',
  CH: 'Switzerland', NO: 'Norway', NZ: 'New Zealand', SG: 'Singapore',
  ZA: 'South Africa', AE: 'UAE', SA: 'Saudi Arabia', TR: 'Turkey',
  TH: 'Thailand', MY: 'Malaysia',
};

export default function ParcelForm({ onResult, onError, onClear }) {
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  // Form state
  const [weight, setWeight] = useState('');
  const [value, setValue] = useState('');
  const [destinationCountry, setDestinationCountry] = useState('');
  const [attributes, setAttributes] = useState([]);

  // Load country codes from backend on mount
  useEffect(() => {
    fetchCountries()
      .then(setCountries)
      .catch((err) => console.error('Failed to load countries:', err));
  }, []);

  // Add a new key-value attribute row
  function addAttribute() {
    setAttributes([...attributes, { key: '', value: '' }]);
  }

  // Remove an attribute row
  function removeAttribute(index) {
    setAttributes(attributes.filter((_, i) => i !== index));
  }

  // Update an attribute row
  function updateAttribute(index, field, val) {
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
    onClear();
    setLoading(true);

    const parcelData = {
      weight: weight === '' ? undefined : Number(weight),
      value: value === '' ? undefined : Number(value),
      destinationCountry: destinationCountry || undefined,
      additionalAttributes: buildAdditionalAttributes(),
    };

    try {
      const result = await routeParcel(parcelData);
      onResult(result.data);
    } catch (err) {
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
      setLoading(false);
    }
  }

  function handleReset() {
    setWeight('');
    setValue('');
    setDestinationCountry('');
    setAttributes([]);
    setFieldErrors({});
    onClear();
  }

  return (
    <form className="parcel-form" onSubmit={handleSubmit}>
      <h2>Route a Parcel</h2>

      {/* Weight */}
      <div className={`form-group ${fieldErrors.weight ? 'has-error' : ''}`}>
        <label htmlFor="parcel-weight">Weight (kg)</label>
        <input
          id="parcel-weight"
          type="number"
          step="any"
          min="0"
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
              {COUNTRY_NAMES[code] || code} ({code})
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
