import { toCsv } from './analytics.service';

/**
 * The CSV writer, tested directly (F165).
 *
 * 🔴 **`toCsv` is exported and had no unit test.** Every assertion about it ran
 * through `GET /analytics/export`, which passes five hardcoded header literals
 * and two numeric columns — so the behaviour of every *other* shape it accepts
 * was unmeasured. That is how the header-row gap below survived: it cannot be
 * reached through the only caller, and nothing else called it.
 *
 * ⚠️ **The e2e suite is not replaced by this.** It proves the route escapes what
 * a merchant typed; this proves the function does, for arguments the route does
 * not currently pass but the next caller might.
 */
describe('toCsv', () => {
  const rows = (csv: string) => csv.split('\r\n');

  /** 📌 RFC 4180 line endings, because Excel on Windows is the reader. */
  it('separates records with CRLF', () => {
    expect(toCsv(['a'], [['1'], ['2']])).toBe('a\r\n1\r\n2');
  });

  it('quotes a cell containing a comma, a quote or a newline', () => {
    expect(toCsv(['a'], [['x,y']])).toContain('"x,y"');
    expect(toCsv(['a'], [['say "hi"']])).toContain('"say ""hi"""');
    expect(toCsv(['a'], [['two\nlines']])).toContain('"two\nlines"');
  });

  /**
   * 🔴 **The formula guard.** A cell beginning `=`, `+`, `-` or `@` executes
   * when the file is opened in Excel or Sheets.
   */
  it.each(['=1+1', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx'])(
    'neutralises %p so a spreadsheet will not execute it',
    (payload) => {
      const cell = rows(toCsv(['a'], [[payload]]))[1];

      expect(cell.startsWith('\t') || cell.startsWith('"\t')).toBe(true);
    },
  );

  /**
   * 🔴 **A numeric column is exempt, or a negative total stops being a number**
   * (F165). `"\t-500"` is text to Excel, and `SUM()` skips it silently.
   */
  it('leaves a negative number in a numeric column summable', () => {
    expect(rows(toCsv(['n'], [['-500']], new Set([0])))[1]).toBe('-500');
  });

  /** ⚠️ And the exemption is per column, not global. */
  it('still guards a text column when another column is numeric', () => {
    const cells = rows(toCsv(['t', 'n'], [['-1+1', '-500']], new Set([1])))[1].split(',');

    expect(cells[0]).toBe('\t-1+1');
    expect(cells[1]).toBe('-500');
  });

  /**
   * 🔴 **The header row is guarded even in a numeric column.**
   *
   * ✏️ **Measured, not assumed — it printed `=BAD` raw.** A header is a name,
   * never a number, so the reason for the numeric exemption does not apply to
   * it. The one caller today passes literals, so nothing was exploitable; the
   * next caller would have inherited a trap with nothing to reveal it.
   */
  it('guards a dangerous header even in a numeric column', () => {
    expect(rows(toCsv(['=BAD'], [['-500']], new Set([0])))[0]).toBe('\t=BAD');
  });

  /** 📌 A header with no formula in it is left exactly as given. */
  it('leaves an ordinary header untouched', () => {
    expect(rows(toCsv(['revenue_minor'], [['1']], new Set([0])))[0]).toBe('revenue_minor');
  });

  /** 📌 No rows is a header alone, not an empty string. */
  it('writes the header when there are no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});
