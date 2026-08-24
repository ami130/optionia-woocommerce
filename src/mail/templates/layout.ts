/**
 * Shared rendering for every template.
 *
 * Templates are typed functions rather than a template engine. The catalogue is
 * small and every message is transactional, so the cost of Handlebars — a runtime
 * dependency, a compile step, and an escaping model that has to be right — buys
 * nothing that a function does not already give, while losing the compiler's
 * check that every placeholder is supplied.
 */

/**
 * Escape for HTML.
 *
 * Names and store names reach these templates from user input. Without this a
 * merchant called `<script>` would produce a message whose HTML depends on what
 * someone typed at registration.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Wrap body content in the shared shell.
 *
 * Deliberately plain: inline styles only, a table-free single column, and no
 * external assets. Mail clients strip stylesheets, block remote images by
 * default, and render nothing consistently — a plain message arrives intact
 * everywhere, and a verification email that renders is worth more than one that
 * looks designed in half the clients.
 */
export function layout(heading: string, bodyHtml: string): string {
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
    'max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0">',
    '<p style="font-size:12px;color:#6b6b6b;margin:0">',
    'Optionia — advanced product options for WooCommerce.',
    '</p>',
    '</div>',
  ].join('');
}

/** A call-to-action button that degrades to a plain link where CSS is stripped. */
export function button(url: string, label: string): string {
  return (
    `<p style="margin:24px 0"><a href="${escapeHtml(url)}" ` +
    'style="background:#1a1a1a;color:#ffffff;padding:12px 20px;border-radius:6px;' +
    `text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>` +
    `<p style="font-size:13px;color:#6b6b6b;margin:0">Or paste this into your browser:<br>` +
    `<span style="word-break:break-all">${escapeHtml(url)}</span></p>`
  );
}
