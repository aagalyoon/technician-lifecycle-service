import { normalizePhone, phonesMatch } from '../../src/utils/phone';

describe('Phone Normalization', () => {
  describe('normalizePhone', () => {
    it('normalizes 10-digit number', () => {
      expect(normalizePhone('5551234567')).toBe('+15551234567');
    });

    it('normalizes number with dashes', () => {
      expect(normalizePhone('555-123-4567')).toBe('+15551234567');
    });

    it('normalizes number with parentheses', () => {
      expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    });

    it('normalizes number with +1 prefix', () => {
      expect(normalizePhone('+15551234567')).toBe('+15551234567');
    });

    it('normalizes number with 1 prefix and spaces', () => {
      expect(normalizePhone('+1 555 123 4567')).toBe('+15551234567');
    });

    it('normalizes number with dots', () => {
      expect(normalizePhone('555.123.4567')).toBe('+15551234567');
    });

    it('normalizes 11-digit number starting with 1', () => {
      expect(normalizePhone('15551234567')).toBe('+15551234567');
    });

    it('returns null for null/undefined/empty', () => {
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone(undefined)).toBeNull();
      expect(normalizePhone('')).toBeNull();
    });

    it('returns null for invalid numbers (too short)', () => {
      expect(normalizePhone('12345')).toBeNull();
    });

    it('returns null for invalid numbers (too long)', () => {
      expect(normalizePhone('123456789012')).toBeNull();
    });

    it('returns null for non-US international numbers', () => {
      // 12-digit starting with 44 (UK)
      expect(normalizePhone('+447911123456')).toBeNull();
    });
  });

  describe('phonesMatch', () => {
    it('matches same number in different formats', () => {
      expect(phonesMatch('(555) 123-4567', '+15551234567')).toBe(true);
      expect(phonesMatch('555-123-4567', '5551234567')).toBe(true);
      expect(phonesMatch('+1 555 555 0001', '5555550001')).toBe(true);
    });

    it('does not match different numbers', () => {
      expect(phonesMatch('5551234567', '5559876543')).toBe(false);
    });

    it('returns false when either is null', () => {
      expect(phonesMatch(null, '5551234567')).toBe(false);
      expect(phonesMatch('5551234567', null)).toBe(false);
      expect(phonesMatch(null, null)).toBe(false);
    });
  });
});
