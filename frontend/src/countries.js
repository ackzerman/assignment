/**
 * Country display names.
 *
 * Single source of truth for VALUES is the backend (full ISO 3166-1
 * alpha-2 set via GET /api/parcels/countries). Labels come from the
 * platform's authoritative CLDR data via Intl.DisplayNames — no
 * hand-maintained partial map that goes stale. Unknown codes fall back
 * to the raw code so valid countries always remain selectable.
 */

let displayNames;

function getDisplayNames() {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

/**
 * Human-readable label for an ISO alpha-2 country code.
 */
export function countryName(code) {
  if (typeof code !== 'string' || !code) return code;
  try {
    const name = getDisplayNames()?.of(code.toUpperCase());
    if (typeof name === 'string' && name) return name;
  } catch {
    // Invalid region subtags throw — fall through to the raw code.
  }
  return code;
}
