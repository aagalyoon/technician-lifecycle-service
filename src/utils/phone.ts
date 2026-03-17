/**
 * Phone number normalization utility.
 *
 * Handles various input formats:
 *   +1 (555) 123-4567
 *   555-123-4567
 *   5551234567
 *   +15551234567
 *   (555) 123 4567
 *
 * Always outputs: +15551234567 (E.164 for US numbers)
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Strip everything except digits
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // If it doesn't look like a valid US number, return null
  // This prevents garbage data from creating phantom matches
  return null;
}

/**
 * Check if two phone numbers are the same after normalization.
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const normA = normalizePhone(a);
  const normB = normalizePhone(b);
  if (!normA || !normB) return false;
  return normA === normB;
}
