type BuildGoogleMapsUrlParams = {
  name?: string | null;
  streetAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

function hasValidCoordinates(
  latitude?: number | null,
  longitude?: number | null
): latitude is number {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  );
}

/**
 * Builds a Google Maps link that resolves to the business place when possible.
 * Prefer name + street address over raw coordinates so Maps shows the venue
 * instead of a DMS coordinate label.
 */
export function buildGoogleMapsUrl(params: BuildGoogleMapsUrlParams): string | null {
  const trimmedName = params.name?.trim();
  const trimmedAddress = params.streetAddress?.trim();
  const labelParts = [trimmedName, trimmedAddress].filter(Boolean);
  const hasCoords = hasValidCoordinates(params.latitude, params.longitude);

  if (labelParts.length > 0) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(labelParts.join(", "))}`;
  }

  if (hasCoords) {
    return `https://www.google.com/maps/search/?api=1&query=${params.latitude},${params.longitude}`;
  }

  return null;
}
