import { slugify } from './tenant-provisioning.service';

/**
 * Slug derivation.
 *
 * A slug appears in URLs and in support conversations, so it must be predictable
 * from the name and safe in a path. Names come from registration input, which
 * means every hostile shape has to produce something usable rather than an error.
 */
describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Sam Merchant')).toBe('sam-merchant');
    expect(slugify('The Best Store')).toBe('the-best-store');
  });

  /** Half-transliterated slugs read worse than plain ones. */
  it('strips accents rather than mangling them', () => {
    expect(slugify('Café Noir')).toBe('cafe-noir');
    expect(slugify('Über Störe')).toBe('uber-store');
  });

  it('removes anything not safe in a URL', () => {
    expect(slugify('Sam & Co. (Ltd)')).toBe('sam-co-ltd');
    expect(slugify('a/b?c=d#e')).toBe('a-b-c-d-e');
  });

  it('collapses runs of separators', () => {
    expect(slugify('Sam   ---   Merchant')).toBe('sam-merchant');
  });

  it('never begins or ends with a hyphen', () => {
    expect(slugify('  Sam  ')).toBe('sam');
    expect(slugify('---Sam---')).toBe('sam');
    expect(slugify('!!!Sam!!!')).toBe('sam');
  });

  /** A trailing hyphen left by truncation reads as a mistake. */
  it('truncates without leaving a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(39)} tail`);

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  /**
   * Returns empty rather than throwing. The caller substitutes a default, which
   * is the right outcome for a name made entirely of emoji.
   */
  it('returns empty for a name with nothing usable in it', () => {
    expect(slugify('🔥🔥🔥')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('produces only URL-safe characters, whatever the input', () => {
    const inputs = ['Sam & Co', '../../etc/passwd', '<script>alert(1)</script>', 'ünïcødé'];

    inputs.forEach((input) => {
      expect(slugify(input)).toMatch(/^[a-z0-9-]*$/);
    });
  });
});
