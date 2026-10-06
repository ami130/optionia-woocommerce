<?php
/**
 * The scene one order line needs rendering, read from the stored config.
 *
 * ## Why this is not part of `RenderRequester`
 *
 * 🔴 **AC3: nothing on a customer-facing read path may reach the network**, and
 * the architecture gate enforces that by banning transport in every caller of
 * `sets_for_product()`. `RenderRequester` posts to the cloud, so it must not be
 * such a caller — the two concerns live in two files precisely so that rule
 * stays mechanically checkable rather than a thing someone remembers.
 *
 * ⚠️ **The split is not cosmetic.** A future change that moved scene building
 * onto a page render would put a config read there and nothing else; the same
 * change inside `RenderRequester` would drag an HTTP client onto the storefront
 * with it. Keeping the transport in a file the gate watches separately is what
 * makes the dangerous version of that edit fail.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Design;

use Optionia\Config\Repository;
use Optionia\Engine\SceneComposer;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Builds the render scene for one order line.
 */
final class LineScene {

	/**
	 * Config repository.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Constructor.
	 *
	 * @param Repository $config Config repository.
	 */
	public function __construct( Repository $config ) {
		$this->config = $config;
	}

	/**
	 * The scene for one line, or null when it carries no artwork.
	 *
	 * 📌 **Null is the ordinary answer**, not an error: most lines on most
	 * orders carry no design, and a line that composes nothing must produce no
	 * render request at all.
	 *
	 * @param mixed $item   WooCommerce order line item.
	 * @param int   $canvas Square canvas size to compose against.
	 *
	 * @return array<string, mixed>|null
	 */
	public function for_item( $item, int $canvas ): ?array {
		if ( ! is_object( $item ) || ! method_exists( $item, 'get_meta' ) ) {
			return null;
		}

		$selections = json_decode( (string) $item->get_meta( Keys::META_SELECTIONS, true ), true );

		if ( ! is_array( $selections ) || array() === $selections ) {
			return null;
		}

		$product_id = method_exists( $item, 'get_product_id' ) ? (int) $item->get_product_id() : 0;

		if ( $product_id <= 0 ) {
			return null;
		}

		return SceneComposer::compose(
			$this->config->option_sets_for_product( $product_id ),
			$selections,
			$canvas,
			$canvas
		);
	}
}
