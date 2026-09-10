<?php
/**
 * The download links a merchant sees on the order screen.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\OrderFiles;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadArchive;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

/**
 * `OrderFiles` rendering a way to reach a customer's artwork.
 *
 * 🔴 **Until this existed a merchant could not reach the file at all.** It is
 * stored under a salt-derived directory with a random name, and
 * `Integration\OrderLineItem` hides `_optionia_selections` from the meta list —
 * correctly, since a raw token means nothing to anyone. The order screen showed
 * that options were chosen and offered no way to get what they produced.
 *
 * @covers \Optionia\Admin\OrderFiles
 */
final class OrderFilesTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['wpdb']              = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_can'] = true;
	}

	protected function tearDown(): void {
		unset( $GLOBALS['wpdb'], $GLOBALS['optionia_test_can'] );
	}

	/** A well-formed upload token. */
	private function token( string $seed = 'a' ): string {
		return str_repeat( $seed, 64 );
	}

	private function files(): OrderFiles {
		$logger  = new Logger( new Settings() );
		$uploads = new UploadRepository();

		return new OrderFiles(
			$uploads,
			new UploadArchive( $uploads, new UploadStore( $logger ), $logger ),
			new UploadLink()
		);
	}

	/**
	 * An order line recording these selections.
	 *
	 * @param array<string, string> $selections Option id to value.
	 */
	private function item( array $selections ): object {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, (string) wp_json_encode( $selections ), true );

		return $item;
	}

	/**
	 * Render one line and return the markup.
	 *
	 * @param object|null $item The line item.
	 */
	private function render( ?object $item ): string {
		ob_start();
		$this->files()->render( 1, $item );

		return (string) ob_get_clean();
	}

	/* --- lines with no files --------------------------------------------- */

	/**
	 * ⚠️ **A colour swatch is not a token.** An ordinary line must render
	 * nothing at all, not an empty container.
	 */
	public function test_a_line_with_no_files_renders_nothing(): void {
		$this->assertSame( '', $this->render( $this->item( array( 'opt-c' => 'red' ) ) ) );
	}

	/** A line this plugin never touched is left alone. */
	public function test_a_line_with_no_optionia_meta_renders_nothing(): void {
		$this->assertSame( '', $this->render( optionia_test_order_item() ) );
	}

	/** An item that cannot be read is survivable. */
	public function test_a_missing_item_renders_nothing(): void {
		$this->assertSame( '', $this->render( null ) );
	}

	/* --- the link -------------------------------------------------------- */

	/**
	 * 🔴 **The link carries the token, never a path.**
	 *
	 * `Upload\UploadStore` records why: the storage guards were measured to be
	 * unreliable, so the real defence is that the path holds two independent
	 * secrets. A link exposing it would spend the directory secret permanently,
	 * for every file the store has ever taken.
	 */
	public function test_the_link_carries_the_token_and_no_path(): void {
		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'art-final-v3.pdf',
			'size_bytes'    => 2048,
		);

		$markup = $this->render( $this->item( array( 'opt-f' => $this->token() ) ) );

		$this->assertStringContainsString( $this->token(), $markup );
		$this->assertStringNotContainsString( 'e5f1c2.pdf', $markup, 'The stored name must never appear.' );
		$this->assertStringNotContainsString( 'optionia-uploads-', $markup, 'The directory must never appear.' );
	}

	/**
	 * ⚠️ **The customer's own filename is what the merchant reads.**
	 *
	 * `art-final-v3.pdf` tells two attachments apart; the stored name is
	 * deliberately meaningless.
	 */
	public function test_the_link_shows_the_customers_filename(): void {
		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'art-final-v3.pdf',
			'size_bytes'    => 2048,
		);

		$this->assertStringContainsString(
			'art-final-v3.pdf',
			$this->render( $this->item( array( 'opt-f' => $this->token() ) ) )
		);
	}

	/** The link carries a nonce, so the endpoint accepts it. */
	public function test_the_link_is_nonced(): void {
		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'art.pdf',
			'size_bytes'    => 10,
		);

		$markup = $this->render( $this->item( array( 'opt-f' => $this->token() ) ) );

		// URL-encoded in the href, which is why the raw value is not asserted.
		$this->assertStringContainsString( '_wpnonce=', $markup );
		$this->assertStringContainsString( rawurlencode( 'nonce:' . Keys::NONCE_DOWNLOAD ), $markup );
	}

	/**
	 * 🔴 **WooCommerce's own `display_meta`, not classes of our own.**
	 *
	 * `Frontend\Assets` enqueues Optionia's admin stylesheet only on Optionia's
	 * own screens, and the WooCommerce order screen is not one — so bespoke
	 * classes here rendered completely unstyled. `display_meta` is already loaded
	 * on this screen and already carries the spacing, size and muted colour the
	 * meta list above uses.
	 */
	public function test_it_reuses_woocommerces_own_meta_styling(): void {
		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'art.pdf',
			'size_bytes'    => 2048,
		);

		$markup = $this->render( $this->item( array( 'opt-f' => $this->token() ) ) );

		$this->assertStringContainsString( 'class="display_meta"', $markup );
		$this->assertStringNotContainsString(
			'optionia-order-file',
			$markup,
			'A class Optionia never loads a stylesheet for is a class that does nothing.'
		);
	}

	/**
	 * 🔴 **A file that vanished is named, even when its neighbours survived.**
	 *
	 * Listing only the files that still exist meant a line holding two, where one
	 * had been released, showed a single link and **no sign the other ever
	 * existed** — the merchant sees one file and cannot know they should have
	 * two. A reprint that arrives short is no better than one that arrives blank.
	 */
	public function test_a_partly_missing_line_reports_the_missing_file(): void {
		$present = str_repeat( 'a', 64 );
		$gone    = str_repeat( 'b', 64 );

		$GLOBALS['wpdb']->rows_by_token = array(
			$present => array(
				'token'         => $present,
				'stored_name'   => 'one.pdf',
				'original_name' => 'front.pdf',
				'size_bytes'    => 10,
			),
			$gone    => null,
		);

		$markup = $this->render(
			$this->item(
				array(
					'opt-a' => $present,
					'opt-b' => $gone,
				)
			)
		);

		$this->assertStringContainsString( 'front.pdf', $markup, 'The surviving file is still offered.' );
		$this->assertStringContainsString(
			'No longer stored',
			$markup,
			'The released file must be reported, not silently omitted.'
		);
	}

	/* --- the bulk button ------------------------------------------------- */

	/**
	 * Render the order's action buttons and return the markup.
	 *
	 * @param mixed $order The order.
	 */
	private function renderBulk( $order ): string {
		ob_start();
		$this->files()->render_bulk( $order );

		return (string) ob_get_clean();
	}

	/**
	 * An order carrying two files, each with its own row.
	 */
	private function orderWithTwoFiles(): object {
		$one = str_repeat( 'a', 64 );
		$two = str_repeat( 'b', 64 );

		$GLOBALS['wpdb']->rows_by_token = array(
			$one => array(
				'token'         => $one,
				'stored_name'   => 'one.pdf',
				'original_name' => 'front.pdf',
				'size_bytes'    => 10,
			),
			$two => array(
				'token'         => $two,
				'stored_name'   => 'two.pdf',
				'original_name' => 'back.pdf',
				'size_bytes'    => 20,
			),
		);

		$item = optionia_test_order_item();
		$item->add_meta_data(
			Keys::META_SELECTIONS,
			(string) wp_json_encode(
				array(
					'opt-a' => $one,
					'opt-b' => $two,
				)
			),
			true
		);

		$order        = optionia_test_order( 64 );
		$order->items = array( $item );

		return $order;
	}

	/** An order with two files is worth one archive. */
	public function test_an_order_with_two_files_offers_a_bulk_download(): void {
		$markup = $this->renderBulk( $this->orderWithTwoFiles() );

		$this->assertStringContainsString( 'Download all files', $markup );
		$this->assertStringContainsString( Keys::ARG_DOWNLOAD_ORDER . '=64', $markup );
	}

	/**
	 * ⚠️ **One file needs no archive**, and a button that zips a single file is
	 * worse than the link already beside it.
	 */
	public function test_an_order_with_one_file_offers_no_bulk_download(): void {
		$token                          = str_repeat( 'a', 64 );
		$GLOBALS['wpdb']->rows_by_token = array(
			$token => array(
				'token'         => $token,
				'stored_name'   => 'one.pdf',
				'original_name' => 'front.pdf',
				'size_bytes'    => 10,
			),
		);

		$item = optionia_test_order_item();
		$item->add_meta_data(
			Keys::META_SELECTIONS,
			(string) wp_json_encode( array( 'opt-a' => $token ) ),
			true
		);

		$order        = optionia_test_order( 64 );
		$order->items = array( $item );

		$this->assertSame( '', $this->renderBulk( $order ) );
	}

	/** An order with no files gets no button on every order in the store. */
	public function test_an_order_with_no_files_offers_no_bulk_download(): void {
		$order        = optionia_test_order( 64 );
		$order->items = array( optionia_test_order_item() );

		$this->assertSame( '', $this->renderBulk( $order ) );
	}

	/** The bulk button is gated on the same capability as everything else. */
	public function test_the_bulk_button_needs_the_capability(): void {
		$GLOBALS['optionia_test_can'] = false;

		$this->assertSame( '', $this->renderBulk( $this->orderWithTwoFiles() ) );
	}

	/* --- the order email ------------------------------------------------- */

	/**
	 * Render the email addition and return the markup.
	 *
	 * @param mixed $order         The order.
	 * @param bool  $sent_to_admin Whether this copy goes to the merchant.
	 * @param bool  $plain_text    Whether this copy is plain text.
	 */
	private function renderEmail( $order, bool $sent_to_admin = true, bool $plain_text = false ): string {
		ob_start();
		$this->files()->render_email( $order, $sent_to_admin, $plain_text, null );

		return (string) ob_get_clean();
	}

	/** The merchant's copy carries a signed link to the order's files. */
	public function test_the_merchants_email_carries_a_signed_link(): void {
		$markup = $this->renderEmail( $this->orderWithTwoFiles() );

		$this->assertStringContainsString( 'Download the uploaded files', $markup );
		$this->assertStringContainsString( Keys::ARG_DOWNLOAD_SIGNATURE, $markup );
		$this->assertStringContainsString( Keys::ARG_DOWNLOAD_EXPIRES, $markup );
	}

	/**
	 * 🔴 **The customer's copy carries nothing.**
	 *
	 * `$sent_to_admin` is what WooCommerce passes so a template can tell the two
	 * copies apart, and reading it means the link cannot leak into a customer
	 * email through a configuration mistake. The customer already has the file
	 * they uploaded; every extra inbox holding a working link is another way it
	 * escapes.
	 */
	public function test_the_customers_email_carries_no_link(): void {
		$this->assertSame( '', $this->renderEmail( $this->orderWithTwoFiles(), false ) );
	}

	/** An order with no stored files earns no link. */
	public function test_an_order_with_no_files_earns_no_email_link(): void {
		$order        = optionia_test_order( 64 );
		$order->items = array( optionia_test_order_item() );

		$this->assertSame( '', $this->renderEmail( $order ) );
	}

	/**
	 * ⚠️ **A plain-text email gets the bare URL.** Rendering an anchor there
	 * shows the merchant the markup instead of the link.
	 */
	public function test_a_plain_text_email_gets_a_bare_url(): void {
		$markup = $this->renderEmail( $this->orderWithTwoFiles(), true, true );

		$this->assertStringNotContainsString( '<a ', $markup );
		$this->assertStringContainsString( 'http', $markup );
	}

	/** An order object that cannot be read is survivable. */
	public function test_a_missing_order_earns_no_email_link(): void {
		$this->assertSame( '', $this->renderEmail( null ) );
	}

	/* --- the guards ------------------------------------------------------ */

	/**
	 * ⚠️ **Gated on the same capability the endpoint enforces.** A link rendered
	 * for someone who cannot use it is a link that invites a support ticket.
	 */
	public function test_it_renders_nothing_without_the_capability(): void {
		$GLOBALS['optionia_test_can'] = false;
		$GLOBALS['wpdb']->rows        = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'art.pdf',
			'size_bytes'    => 10,
		);

		$this->assertSame( '', $this->render( $this->item( array( 'opt-f' => $this->token() ) ) ) );
	}

	/**
	 * 🔴 **A released file is reported, not left blank.**
	 *
	 * Retention on a deleted order, or expiry before promotion landed, removes
	 * the row. A merchant looking for artwork needs to know it is gone rather
	 * than wonder whether the screen is broken.
	 */
	public function test_a_file_that_is_gone_says_so(): void {
		$GLOBALS['wpdb']->rows = null;

		$markup = $this->render( $this->item( array( 'opt-f' => $this->token() ) ) );

		$this->assertStringContainsString( 'No longer stored', $markup );
		$this->assertStringNotContainsString( '<a ', $markup, 'No link may be offered for a file that is gone.' );
	}
}
