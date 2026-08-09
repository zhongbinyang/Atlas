export function centerWebBaseUrl(centerUrl?: string | null) {
  if (!centerUrl?.trim()) return null;
  return centerUrl.trim().replace(/\/api\/?$/i, '').replace(/\/$/, '');
}

export function centerConfigsPageUrl(centerUrl?: string | null) {
  const base = centerWebBaseUrl(centerUrl);
  return base ? `${base}/#/configs` : null;
}
