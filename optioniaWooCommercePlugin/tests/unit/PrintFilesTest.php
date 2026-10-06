<?php
/**
 * The merchant's way to a print file (M26e.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Design\PrintFiles;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- `$product` is WooCommerce's global.

/**
 * `Design\PrintFiles` shows the artwork an order line produced.
 *
 * 🔴 **`RenderCollector` wrote `META_RENDER_FILES` and nothing read it.** A
 * customer bought, the cloud rendered, the plugin downloaded the file into a
 * guarded directory — and the order screen gave no sign it existed. The whole
 * pipeline produced something no one could reach.
 *
 * @covers \Optionia\Design\PrintFiles
 */
final class PrintFilesTest extends TestCase {

	/** A real PNG header, so the stored file is a plausible print file. */
	private const PNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";

	/**
	 * The file this test wrote, for teardown.
	 *
	 * @var string
	 */
	private string $written = '';

	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_orders']  = array();
		$GLOBALS['optionia_test_can']     = true;
	}

	protected function tearDown(): void {
		if ( '' !== $this->written && is_file( $this->written ) ) {
			wp_delete_file( $this->written );
		}
	}

	private function printFiles(): PrintFiles {
		$logger = new Logger( new Settings() );

		return new PrintFiles( new UploadStore( $logger ), $logger );
	}

	/**
	 * An order whose line has a collected print file on disk.
	 *
	 * @param bool $on_disk Whether to actually write the file.
	 */
	private function orderWithPrintFile( bool $on_disk = true ): object {
		$logger = new Logger( new Settings() );
		$store  = new UploadStore( $logger );
		$name   = $store->unique_filename( 'png' );

		if ( $on_disk ) {
			$directory     = $store->directory();
			$this->written = $directory . '/' . $name;

			file_put_contents( $this->written, self::PNG ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- writing a fixture into the plugin's own directory.
		}

		$item  = optionia_test_order_item();
		$order = optionia_test_order( 90 );

		$order->items = array( 11 => $item );
		$order->update_meta_data( Keys::META_RENDER_FILES, (string) wp_json_encode( array( 11 => $name ) ) );

		$GLOBALS['optionia_test_orders'][90] = $order;

		return $order;
	}

	/** Render the order-screen row for one line. */
	private function markup( int $line = 11 ): string {
		ob_start();
		$this->printFiles()->render( $line, null );

		return (string) ob_get_clean();
	}

	public function test_it_offers_a_download_for_a_collected_file(): void {
		$this->orderWithPrintFile();

		$markup = $this->markup();

		$this->assertStringContainsString( 'Print file', $markup );
		$this->assertStringContainsString( Keys::ARG_PRINT_LINE . '=11', $markup );
		$this->assertStringContainsString( Keys::ARG_PRINT_ORDER . '=90', $markup );
	}

	/**
	 * 🔴 **The link carries ids, never the stored name or a path.**
	 * `UploadStore`'s defence is that the path holds two independent secrets,
	 * and a link exposing the stored name would spend one of them permanently
	 * — for every file the store has ever taken.
	 */
	public function test_the_link_never_exposes_the_stored_name(): void {
		$order = $this->orderWithPrintFile();
		$name  = json_decode( (string) $order->get_meta( Keys::META_RENDER_FILES ), true )[11];

		$markup = $this->markup();

		$this->assertStringNotContainsString( (string) $name, $markup );
		$this->assertStringNotContainsString( 'wp-content', $markup );

		/*
		 * 🔴 **The line argument is the LINE ID, read from the href itself.**
		 *
		 * ⚠️ **Two weaker versions of this passed with the link carrying the
		 * stored NAME.** Asserting the name was absent proved nothing, because
		 * `html_entity_decode` was never applied; appending `&` to the whole
		 * markup matched trivially. Parsing the query string is what makes the
		 * argument's VALUE the subject.
		 */
		preg_match( '/href="([^"]*)"/', $markup, $href );

		parse_str( (string) wp_parse_url( html_entity_decode( $href[1] ?? '' ), PHP_URL_QUERY ), $query );

		$this->assertSame( '11', (string) ( $query[ Keys::ARG_PRINT_LINE ] ?? '' ) );
		$this->assertSame( '90', (string) ( $query[ Keys::ARG_PRINT_ORDER ] ?? '' ) );
	}

	/**
	 * 🔴 **A traversal segment must not escape the guarded directory.**
	 *
	 * ⚠️ **What this does and does not prove.** The row refuses, which is the
	 * behaviour that matters. It does NOT kill the `$safe !== $name`
	 * comparison: `basename()` has already reduced the name to `hosts`, which
	 * is not in the guarded directory, so `is_file()` refuses it either way.
	 * That comparison is recorded in `PrintFiles` as an equivalent mutant and
	 * kept as defence in depth — a file named `hosts` inside the directory
	 * would otherwise be served to a caller who asked for `/etc/hosts`.
	 */
	public function test_a_traversal_name_is_refused(): void {
		$order = optionia_test_order( 92 );

		$order->items = array( 13 => optionia_test_order_item() );
		$order->update_meta_data(
			Keys::META_RENDER_FILES,
			(string) wp_json_encode( array( 13 => '../../../etc/hosts' ) )
		);

		$GLOBALS['optionia_test_orders'][92] = $order;

		$markup = $this->markup( 13 );

		/* Reported as missing, never offered as a download. */
		$this->assertStringContainsString( 'No longer stored', $markup );
		$this->assertStringNotContainsString( Keys::ARG_PRINT_LINE . '=', $markup );
	}

	/**
	 * ⚠️ **A missing file is REPORTED, not omitted.** A line whose artwork was
	 * swept would otherwise look identical to one that never had any, and a
	 * reprint that arrives short is no better than one that arrives blank.
	 */
	public function test_a_missing_file_is_reported_rather_than_hidden(): void {
		$this->orderWithPrintFile( false );

		$markup = $this->markup();

		$this->assertStringContainsString( 'Print file', $markup );
		$this->assertStringContainsString( 'No longer stored', $markup );
		$this->assertStringNotContainsString( Keys::ARG_PRINT_LINE . '=', $markup );
	}

	/** A line with no print file shows nothing at all. */
	public function test_a_line_with_no_print_file_renders_nothing(): void {
		$order        = optionia_test_order( 91 );
		$order->items = array( 12 => optionia_test_order_item() );

		$GLOBALS['optionia_test_orders'][91] = $order;

		$this->assertSame( '', $this->markup( 12 ) );
	}

	/**
	 * 🔴 **A link rendered for someone who cannot use it invites a support
	 * ticket**, and this is the same capability the download enforces.
	 */
	public function test_nothing_is_rendered_without_the_capability(): void {
		$this->orderWithPrintFile();

		$GLOBALS['optionia_test_can'] = false;

		$this->assertSame( '', $this->markup() );
	}

	/** The link is nonced, so a stale one cannot be replayed indefinitely. */
	public function test_the_link_carries_a_nonce(): void {
		$this->orderWithPrintFile();

		$this->assertStringContainsString( '_wpnonce=', $this->markup() );
	}

	/*
	--- the download ----------------------------------------------------
	 *
	 * 🔴 **This half had no tests at all**, which is how a security boundary
	 * ships unguarded: `render()` only decides whether a LINK appears, while
	 * `maybe_download()` decides whether a FILE is served — capability, nonce,
	 * order lookup, path resolution and streaming.
	 *
	 * ⚠️ **The refusals are what these can reach.** A successful download ends
	 * in `exit`, which would take the runner with it, and this suite uses no
	 * process isolation — the same honest limit `UploadDownloadTest` records.
	 * So every branch deciding *whether* a merchant sees a file is covered,
	 * and only the writing of the body is not.
	 *
	 * 📌 **A removed guard surfaces as an ERROR, not a failure**, and that is
	 * still a kill. Execution reaches `header()`, which throws because PHPUnit
	 * has already written output — so the test detects the guard's absence by
	 * the only signal available. Verified one mutant at a time: removing the
	 * capability check fails exactly `test_it_refuses_without_the_capability`.
	 */

	/**
	 * Point a request at one line's print file.
	 *
	 * @param int         $order Order id.
	 * @param int         $line  Line item id.
	 * @param string|null $nonce Override the nonce; null sends a valid one.
	 */
	private function request( int $order, int $line, ?string $nonce = null ): void {
		$_GET = array(
			Keys::ARG_PRINT_ORDER => (string) $order,
			Keys::ARG_PRINT_LINE  => (string) $line,
			'_wpnonce'            => $nonce ?? ( 'nonce:' . Keys::NONCE_DOWNLOAD ),
		);
	}

	/** Run the handler and return why it stopped, or '' when it did not. */
	private function refusal(): string {
		try {
			$this->printFiles()->maybe_download();
		} catch ( \Optionia_Test_Halt $halt ) {
			return $halt->getMessage();
		}

		return '';
	}

	/**
	 * ⚠️ **`admin_init` fires on every admin request.** A handler acting on
	 * anything but its own arguments would run on every page in wp-admin.
	 */
	public function test_it_ignores_a_request_that_asks_for_nothing(): void {
		$_GET = array();

		$this->assertSame( '', $this->refusal() );
	}

	/**
	 * 🔴 **Capability before the nonce, and before any lookup.** A failed nonce
	 * tells a caller the argument was recognised; refusing on capability first
	 * keeps an unauthenticated probe from learning anything at all.
	 */
	public function test_it_refuses_without_the_capability(): void {
		$this->orderWithPrintFile();
		$this->request( 90, 11 );

		$GLOBALS['optionia_test_can'] = false;

		$this->assertStringContainsString( 'permission', $this->refusal() );
	}

	/** A stale or forged link is refused. */
	public function test_it_refuses_a_bad_nonce(): void {
		$this->orderWithPrintFile();
		$this->request( 90, 11, 'not-the-nonce' );

		$this->assertStringContainsString( 'expired', $this->refusal() );
	}

	/** An order that does not exist cannot yield a file. */
	public function test_it_refuses_an_unknown_order(): void {
		$this->orderWithPrintFile();
		$this->request( 999, 11 );

		$this->assertStringContainsString( 'order could not be found', $this->refusal() );
	}

	/**
	 * ⚠️ **A line on a REAL order that has no print file.** This is the shape a
	 * guessed id takes, and it must not fall through to a path lookup.
	 */
	public function test_it_refuses_a_line_with_no_print_file(): void {
		$this->orderWithPrintFile();
		$this->request( 90, 77 );

		$this->assertStringContainsString( 'no print file', $this->refusal() );
	}

	/**
	 * 🔴 **A traversal name is refused rather than resolved.** The name is read
	 * back from order meta, which only this plugin writes — but a segment
	 * reaching here would read any file the web user can.
	 */
	public function test_it_refuses_a_traversal_name(): void {
		$order        = optionia_test_order( 93 );
		$order->items = array( 14 => optionia_test_order_item() );

		$order->update_meta_data(
			Keys::META_RENDER_FILES,
			(string) wp_json_encode( array( 14 => '../../../etc/hosts' ) )
		);

		$GLOBALS['optionia_test_orders'][93] = $order;

		$this->request( 93, 14 );

		$this->assertStringContainsString( 'no longer stored', strtolower( $this->refusal() ) );
	}

	/** A file the sweeper removed between render and click is said plainly. */
	public function test_it_reports_a_file_that_is_no_longer_on_disk(): void {
		$this->orderWithPrintFile( false );
		$this->request( 90, 11 );

		$this->assertStringContainsString( 'no longer stored', strtolower( $this->refusal() ) );
	}

	/**
	 * 📌 **The resolver answers a real path for a stored file.**
	 *
	 * ⚠️ **The streaming call itself is out of reach**, and a first version of
	 * this test tried anyway: it ran `maybe_download()` to completion and died
	 * on `Cannot modify header information` — PHPUnit has already written
	 * output, so `header()` throws. `UploadDownloadTest` records the same
	 * limit and asserts nothing past the decision branches.
	 *
	 * So this asserts what IS reachable and what the refusal tests cannot say
	 * on their own: that a stored file resolves rather than being refused —
	 * proven through the rendered row, which offers a download only when
	 * `path_for()` returned one.
	 */
	public function test_a_stored_file_resolves_rather_than_refusing(): void {
		$this->orderWithPrintFile();

		$markup = $this->markup();

		$this->assertStringContainsString( 'Download', $markup );
		$this->assertStringNotContainsString( 'No longer stored', $markup );
	}
}
