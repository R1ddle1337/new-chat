export const STREAM_RESPONSES_STORAGE_KEY = 'nchat_stream_responses';

function normalizeBooleanStorageValue(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  return fallback;
}

export function readStreamResponsesPreference(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const rawValue = window.localStorage.getItem(STREAM_RESPONSES_STORAGE_KEY);
    return normalizeBooleanStorageValue(rawValue, true);
  } catch {
    return true;
  }
}

export function writeStreamResponsesPreference(nextValue: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STREAM_RESPONSES_STORAGE_KEY, nextValue ? 'true' : 'false');
  } catch {
    // Ignore write failures, fallback remains enabled by default.
  }
}
