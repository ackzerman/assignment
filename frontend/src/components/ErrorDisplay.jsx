/**
 * ErrorDisplay — Shows validation errors or API errors clearly.
 *
 * Two modes:
 * - Validation errors: shows a list of field-level issues
 * - General errors: shows a single error message
 *
 * Design: Operators should immediately understand what went wrong
 * and how to fix it, without technical jargon.
 */

export default function ErrorDisplay({ error }) {
  if (!error) return null;

  // Validation errors — show each field error
  if (error.validationErrors && error.validationErrors.length > 0) {
    return (
      <div className="error-display validation-errors">
        <h3>Please fix the following issues:</h3>
        <ul>
          {error.validationErrors.map((ve, index) => (
            <li key={index}>
              <strong>{formatFieldName(ve.field)}:</strong> {ve.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // General error
  return (
    <div className="error-display general-error">
      <p>{error.message || 'An unexpected error occurred. Please try again.'}</p>
    </div>
  );
}

/**
 * Converts field names like 'destinationCountry' or 'additionalAttributes.fragile'
 * into human-readable labels like 'Destination Country' or 'Attribute: fragile'
 */
function formatFieldName(field) {
  if (field.startsWith('additionalAttributes.')) {
    return `Attribute: ${field.split('.')[1]}`;
  }

  const labels = {
    weight: 'Weight',
    value: 'Value',
    destinationCountry: 'Destination Country',
    additionalAttributes: 'Additional Attributes',
  };

  return labels[field] || field;
}
