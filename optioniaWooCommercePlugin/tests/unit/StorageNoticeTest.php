<?php
/**
 * The storage-full notice (M15.6).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\StorageNotice;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * What a merchant is told when their plan storage is used up.
 *
 * 🔴 **`file_storage_mb` was the last unenforced plan limit.** Phase 15's exit
 * criterion reads *"per-plan quotas **enforced** and metered"* and only metering
 * shipped — `docs/SUBSCRIPTION-POLICY.md` said so to merchants in as many words.
 *
 * ⚠️ **The refusal itself is deliberately opaque** — `UploadEndpoint::refused()`
 * returns one shape for every reason so a caller cannot map the ceilings. This
 * notice is therefore the **only** place a merchant learns why their customers'
 * uploads stopped.
 *
 * @covers \Optionia\Admin\StorageNotice
 */
final class StorageNoticeTest extends TestCase {

	/**
	 * Reset state between tests.
	 */
	/**
	 * Restore the shared capability global.
	 *
	 * 🔴 **A test that sets `optionia_test_can = false` and does not put it back
	 * poisons every test that runs after it**, and CI proved it: this file left
	 * it false, and `UnpricedTypesTest` — which never sets it and reasonably
	 * expects a manager — rendered an empty notice and failed on an assertion
	 * about text it had nothing to do with.
	 *
	 * ⚠️ **`setUp` alone is not enough**, which is why this exists. Setting it
	 * true at the start of *this* file's cases protects this file; it does
	 * nothing for a file that never sets it and runs next.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_can'] = true;

		parent::tearDown();
	}

	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_can']     = true;
	}

	/**
	 * Capture what the notice prints for a given heartbeat record.
	 *
	 * @param array<string, mixed>|null $heartbeat The last heartbeat entry.
	 */
	private function render( ?array $heartbeat ): string {
		if ( null !== $heartbeat ) {
			update_option( Keys::OPTION_LAST_HEARTBEAT, $heartbeat, false );
		}

		ob_start();
		( new StorageNotice() )->render();

		return (string) ob_get_clean();
	}

	/**
	 * 🔴 **The notice a blocked merchant must see.** Without it a shopper is
	 * refused, the merchant sees nothing, and a lost sale has no visible cause.
	 */
	public function test_it_warns_when_uploads_are_being_refused(): void {
		$html = $this->render(
			array(
				'at'              => time(),
				'ok'              => true,
				'uploads_allowed' => false,
			)
		);

		$this->assertStringContainsString( 'file storage is full', $html );
		$this->assertStringContainsString( 'declined', $html );
	}

	/**
	 * 🔴 **It says what still works.** A merchant reading only "storage full"
	 * assumes their shop is broken; every option that is not a file upload keeps
	 * selling exactly as before.
	 */
	public function test_it_says_the_rest_of_the_shop_is_unaffected(): void {
		$html = $this->render(
			array(
				'at'              => time(),
				'ok'              => true,
				'uploads_allowed' => false,
			)
		);

		$this->assertStringContainsString( 'keeps working normally', $html );
		$this->assertStringContainsString( 'nothing has been deleted', $html );
	}

	/** ⚠️ **A warning, never an error** — the shop is not down. */
	public function test_it_is_a_warning_not_an_error(): void {
		$html = $this->render(
			array(
				'at'              => time(),
				'ok'              => true,
				'uploads_allowed' => false,
			)
		);

		$this->assertStringContainsString( 'notice-warning', $html );
		$this->assertStringNotContainsString( 'notice-error', $html );
	}

	/** 📌 Silent while there is room. A notice everyone sees is one nobody reads. */
	public function test_it_says_nothing_while_uploads_are_allowed(): void {
		$this->assertSame(
			'',
			$this->render(
				array(
					'at'              => time(),
					'ok'              => true,
					'uploads_allowed' => true,
				)
			)
		);
	}

	/**
	 * 🔴 **A heartbeat from a cloud older than M15.6 carries no verdict**, and
	 * absent must mean allowed. Defaulting to "refuse" would pause uploads on
	 * every store the moment the plugin updated ahead of the backend.
	 */
	public function test_it_says_nothing_when_the_heartbeat_predates_the_field(): void {
		$this->assertSame(
			'',
			$this->render(
				array(
					'at'                   => time(),
					'ok'                   => true,
					'cloud_config_version' => 4,
				)
			)
		);
	}

	/** 📌 And a store that has never heartbeated has no verdict to act on. */
	public function test_it_says_nothing_without_a_heartbeat(): void {
		$this->assertSame( '', $this->render( null ) );
	}

	/**
	 * 🔴 **Only for someone who can act on it.** A shop manager who cannot
	 * change the plan is told about a problem they cannot fix.
	 */
	public function test_it_is_hidden_from_users_who_cannot_manage(): void {
		$GLOBALS['optionia_test_can'] = false;

		$this->assertSame(
			'',
			$this->render(
				array(
					'at'              => time(),
					'ok'              => true,
					'uploads_allowed' => false,
				)
			)
		);
	}

	/**
	 * 📌 **System Status and the notice cannot disagree**, so support reads the
	 * same fact the merchant does.
	 */
	public function test_is_showing_agrees_with_what_is_rendered(): void {
		update_option(
			Keys::OPTION_LAST_HEARTBEAT,
			array(
				'at'              => time(),
				'ok'              => true,
				'uploads_allowed' => false,
			),
			false
		);

		$this->assertTrue( ( new StorageNotice() )->is_showing() );
	}
}
