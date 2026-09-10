<?php
/**
 * Releasing an order's files when the order is permanently deleted.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadRetention;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

/**
 * `UploadRetention` closing the deleted-order leak.
 *
 * 🔴 **A promoted file was unreachable by every cleanup path.** Nothing resets
 * `order_id`, so `UploadExpirer` skipped the row (`WHERE order_id IS NULL`) and
 * `UploadSweeper` protected the file (the table knew its name). Deleting an
 * order left its artwork on disk forever.
 *
 * @covers \Optionia\Upload\UploadRetention
 */
final class UploadRetentionTest extends TestCase {

	/**
	 * The uploads root for this test.
	 *
	 * @var string
	 */
	private string $base = '';

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-ret-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);

		$GLOBALS['wpdb']                  = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_options'] = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['optionia_test_upload_dir'], $GLOBALS['wpdb'] );

		$this->removeTree( $this->base );
	}

	/**
	 * Delete a directory and everything in it.
	 *
	 * @param string $dir Absolute path.
	 */
	private function removeTree( string $dir ): void {
		if ( ! is_dir( $dir ) ) {
			return;
		}

		$entries = scandir( $dir );

		foreach ( false === $entries ? array() : $entries as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}

			$path = $dir . '/' . $entry;

			if ( is_dir( $path ) ) {
				$this->removeTree( $path );
			} else {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test teardown.
				unlink( $path );
			}
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- test teardown.
		rmdir( $dir );
	}

	/** A well-formed upload token. */
	private function token( string $seed = 'a' ): string {
		return str_repeat( $seed, 64 );
	}

	private function retention(): UploadRetention {
		$logger = new Logger( new Settings() );

		return new UploadRetention( new UploadRepository(), new UploadStore( $logger ), $logger );
	}

	/**
	 * Put a real file in the store.
	 *
	 * @param string $name Stored name.
	 */
	private function storedFile( string $name ): string {
		$logger    = new Logger( new Settings() );
		$directory = ( new UploadStore( $logger ) )->directory();

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $directory . '/' . $name, 'bytes' );

		return $directory . '/' . $name;
	}

	/**
	 * An order whose one line records these selections.
	 *
	 * @param array<string, string> $selections Option id to value.
	 */
	private function orderWith( array $selections ): object {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, (string) wp_json_encode( $selections ), true );

		$order        = optionia_test_order( 64 );
		$order->items = array( $item );

		return $order;
	}

	/* --- the release ----------------------------------------------------- */

	/**
	 * 🔴 **The leak this class closes.** Before it, the file and its row both
	 * survived the order forever.
	 */
	public function test_it_deletes_the_file_and_row_of_a_deleted_order(): void {
		$path = $this->storedFile( 'art.pdf' );

		$GLOBALS['wpdb']->rows = array(
			'token'       => $this->token(),
			'stored_name' => 'art.pdf',
			'order_id'    => 64,
		);

		$this->retention()->release( 64, $this->orderWith( array( 'opt-f' => $this->token() ) ) );

		$this->assertFileDoesNotExist( $path, 'The file must go with the order.' );
		$this->assertCount( 1, $GLOBALS['wpdb']->deletes );
		$this->assertSame( array( 'token' => $this->token() ), $GLOBALS['wpdb']->deletes[0]['where'] );
	}

	/**
	 * ⚠️ **A selection that is not a token is not a file.** An order full of
	 * colour swatches must not send anything to the upload table.
	 */
	public function test_an_order_with_no_files_deletes_nothing(): void {
		$this->retention()->release( 64, $this->orderWith( array( 'opt-c' => 'red' ) ) );

		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/** An order object that cannot be read yields nothing rather than guessing. */
	public function test_a_missing_order_object_is_survivable(): void {
		$this->retention()->release( 64, null );

		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/** A token whose row is already gone needs no second deletion. */
	public function test_a_token_with_no_row_is_skipped(): void {
		$GLOBALS['wpdb']->rows = null;

		$this->retention()->release( 64, $this->orderWith( array( 'opt-f' => $this->token() ) ) );

		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/**
	 * 🔴 **A file another order owns is never deleted.**
	 *
	 * Reachable on data written before Stage 4d, when `OrderAgain` replayed a
	 * token into a new order and nothing refused it — so two orders could carry
	 * the same token. Deleting the reorder would then destroy the original
	 * order's artwork, the exact opposite of this class's purpose.
	 */
	public function test_a_file_another_order_owns_is_kept(): void {
		$path = $this->storedFile( 'art.pdf' );

		$GLOBALS['wpdb']->rows = array(
			'token'       => $this->token(),
			'stored_name' => 'art.pdf',
			'order_id'    => 99,
		);

		// Order 64 is being deleted; the row belongs to order 99.
		$this->retention()->release( 64, $this->orderWith( array( 'opt-f' => $this->token() ) ) );

		$this->assertFileExists( $path, "Another order's artwork must survive." );
		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/**
	 * ⚠️ **An unclaimed row still belongs to this order.**
	 *
	 * A file whose promotion failed at checkout keeps `order_id` null while the
	 * order plainly refers to it. Requiring a match outright would leave exactly
	 * those files behind — the leak this class exists to close.
	 */
	public function test_a_file_whose_promotion_failed_is_still_released(): void {
		$path = $this->storedFile( 'art.pdf' );

		$GLOBALS['wpdb']->rows = array(
			'token'       => $this->token(),
			'stored_name' => 'art.pdf',
			'order_id'    => null,
		);

		$this->retention()->release( 64, $this->orderWith( array( 'opt-f' => $this->token() ) ) );

		$this->assertFileDoesNotExist( $path );
		$this->assertCount( 1, $GLOBALS['wpdb']->deletes );
	}

	/** Without an order id nothing can be proven, so nothing is deleted. */
	public function test_an_order_with_no_id_deletes_nothing(): void {
		$GLOBALS['wpdb']->rows = array(
			'token'       => $this->token(),
			'stored_name' => 'art.pdf',
			'order_id'    => 64,
		);

		$this->retention()->release( 0, null );

		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/**
	 * 🔴 **Trashing is not deleting.**
	 *
	 * A trashed order keeps its items and can be restored. Listening to
	 * `woocommerce_trash_order` would turn a reversible action into an
	 * irreversible one and lose a customer's print file to a misclick.
	 */
	public function test_it_listens_before_deletion_and_not_on_trashing(): void {
		$this->assertSame( 'woocommerce_before_delete_order', UploadRetention::HOOK );
		$this->assertNotSame( 'woocommerce_trash_order', UploadRetention::HOOK );
	}

	/**
	 * ⚠️ **The hook must fire *before* `delete_items()`.**
	 *
	 * Measured in WooCommerce 11.0.1: `OrdersTableDataStore::delete()` deletes
	 * the items at line 2637 and fires `woocommerce_delete_order` at 2668 — by
	 * which point `_optionia_selections` is gone and there is nothing to read.
	 */
	public function test_the_hook_is_the_one_that_still_has_the_items(): void {
		$this->assertStringContainsString( 'before_delete', UploadRetention::HOOK );
	}
}
