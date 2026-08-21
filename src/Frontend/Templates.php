<?php
/**
 * Theme-overridable template loader.
 *
 * Principle 4: templates receive a prepared view-model and nothing else — no
 * global lookups, no config reads, no business logic. That is what makes them
 * safe for a merchant's theme to override, and testable in isolation.
 *
 * Resolution order follows the WooCommerce convention merchants and agencies
 * already expect:
 *   1. {child theme}/woocommerce/optionia/{template}
 *   2. {parent theme}/woocommerce/optionia/{template}
 *   3. {plugin}/templates/{template}
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Frontend;

use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Locates and renders templates.
 */
final class Templates {

	/**
	 * Directory inside a theme where overrides live.
	 */
	private const THEME_DIR = 'woocommerce/optionia';

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Resolved paths, keyed by template name.
	 *
	 * The builder renders the same option template repeatedly; resolving the
	 * theme override once per request avoids a filesystem stat per option.
	 *
	 * @var array<string, string|null>
	 */
	private array $resolved = array();

	/**
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Render a template to a string.
	 *
	 * Returns an empty string when the template is missing rather than throwing:
	 * a missing partial should cost one option group, never a fatal error on a
	 * merchant's storefront (Principle 7).
	 *
	 * @param string              $template Template path relative to templates/, e.g. 'options/text.php'.
	 * @param array<string, mixed> $data     View-model exposed to the template.
	 */
	public function render( string $template, array $data = array() ): string {
		$path = $this->locate( $template );

		if ( null === $path ) {
			$this->logger->warning( 'Template not found.', array( 'template' => $template ) );

			return '';
		}

		ob_start();

		/**
		 * The view-model. Named `$optionia` rather than extracted into scope so
		 * a template cannot accidentally shadow a WordPress global, and so it is
		 * obvious in the template which values are ours.
		 *
		 * @var array<string, mixed> $optionia
		 */
		$optionia = $data;

		include $path;

		return (string) ob_get_clean();
	}

	/**
	 * Echo a template.
	 *
	 * @param string              $template Template path relative to templates/.
	 * @param array<string, mixed> $data     View-model.
	 */
	public function output( string $template, array $data = array() ): void {
		// Templates are responsible for escaping their own output; the loader
		// must not double-escape already-safe markup.
		echo $this->render( $template, $data ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	/**
	 * Resolve a template to an absolute path, honouring theme overrides.
	 *
	 * @param string $template Template path relative to templates/.
	 */
	public function locate( string $template ): ?string {
		if ( array_key_exists( $template, $this->resolved ) ) {
			return $this->resolved[ $template ];
		}

		$safe = $this->sanitize_relative_path( $template );

		if ( null === $safe ) {
			$this->logger->warning( 'Rejected an unsafe template path.', array( 'template' => $template ) );

			$this->resolved[ $template ] = null;

			return null;
		}

		$candidates = array(
			get_stylesheet_directory() . '/' . self::THEME_DIR . '/' . $safe,
			get_template_directory() . '/' . self::THEME_DIR . '/' . $safe,
			$this->plugin_templates_dir() . $safe,
		);

		foreach ( $candidates as $candidate ) {
			if ( is_readable( $candidate ) ) {
				/**
				 * Filters the resolved path of an Optionia template.
				 *
				 * @param string $candidate Absolute path.
				 * @param string $safe      Relative template path.
				 */
				$this->resolved[ $template ] = (string) apply_filters(
					'optionia_locate_template',
					$candidate,
					$safe
				);

				return $this->resolved[ $template ];
			}
		}

		$this->resolved[ $template ] = null;

		return null;
	}

	/**
	 * Reject traversal and absolute paths.
	 *
	 * Template names are internal, but this class is filterable and could be
	 * reached with caller-supplied input in future. Validating here means that
	 * cannot become a file-disclosure bug.
	 *
	 * @param string $template Candidate relative path.
	 */
	private function sanitize_relative_path( string $template ): ?string {
		$template = ltrim( $template, '/\\' );

		if ( '' === $template ) {
			return null;
		}

		if ( false !== strpos( $template, '..' ) || false !== strpos( $template, "\0" ) ) {
			return null;
		}

		if ( ! preg_match( '#^[A-Za-z0-9_\-/]+\.php$#', $template ) ) {
			return null;
		}

		return $template;
	}

	/**
	 * Absolute path to the plugin's templates directory, trailing slash included.
	 */
	private function plugin_templates_dir(): string {
		return plugin_dir_path( OPTIONIA_PLUGIN_FILE ) . 'templates/';
	}
}
