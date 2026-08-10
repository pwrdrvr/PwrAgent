export function normalizeAsarListing(listing) {
  return listing.map((entry) => entry.replaceAll("\\", "/"));
}
