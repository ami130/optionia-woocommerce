<?php
/**
 * The lapsed-subscription notice (M24.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\SubscriptionNotice;
use Optionia\Config\Repository;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * What a merchant is told when their subscription has lapsed.
 *
 * 🔴 **The cloud shipped `plan.read_only` and nothing read it.** M24.5 says the
 * document carries plan state *"so the plugin can show accurate notices"*, and
 * until this existed no merchant ever saw one — the purpose clause of the
 * milestone was unmet while the data half passed every test. The same defect as
 * F132, where the dashboard ignored `usage[]`.
 *
 * @covers \Optionia\Admin\SubscriptionNotice
 */
final class SubscriptionNoticeTest extends TestCase {

	/**
	 * Reset state between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_can']     = true;
	}

	/**
	 * Capture what the notice prints for a given document.
	 *
	 * @param array<string, mixed>|null $document The cached config document.
	 */
	private function render( ?array $document ): string {
		$config = new Repository( new Logger( new Settings() ) );

		if ( null !== $document ) {
			$config->store( $document );
		}

		ob_start();
		( new SubscriptionNotice( $config ) )->render();

		return (string) ob_get_clean();
	}

	/**
	 * A document in the shape the cloud sends.
	 *
	 * @param array<string, mixed> $plan Plan state overrides.
	 */
	private function document( array $plan ): array {
		return array(
			'schema_version' => 1,
			'config_version' => 1,
			'store_id'       => 'store-1',
			'generated_at'   => '2026-09-28T00:00:00.000Z',
			'option_sets'    => array(),
			'plan'           => array_merge(
				array(
					'code'          => 'free',
					'name'          => 'Free',
					'read_only'     => false,
					'grace_ends_at' => null,
				),
				$plan
			),
		);
	}

	/**
	 * 🔴 **The notice a lapsed merchant must see.** Without it the cloud pauses
	 * their editing and the plugin says nothing about why.
	 */
	public function test_it_warns_when_authoring_has_paused(): void {
		$html = $this->render( $this->document( array( 'read_only' => true ) ) );

		$this->assertStringContainsString( 'editing is paused', $html );
	}

	/**
	 * 🔴 **It leads with the reassurance, because the shop is NOT down.**
	 * ADR-116 keeps the storefront serving through a lapse; a merchant who
	 * reads "subscription lapsed" and nothing else assumes an outage.
	 */
	public function test_it_says_the_storefront_still_works(): void {
		$html = $this->render( $this->document( array( 'read_only' => true ) ) );

		$this->assertStringContainsString( 'keep working normally', $html );
		$this->assertStringContainsString( 'nothing has been deleted', strtolower( $html ) );
	}

	/**
	 * ⚠️ **A warning, never an error.** The same reasoning `SchemaNotice`
	 * records: an error notice sends a merchant hunting for an outage that is
	 * not happening.
	 */
	public function test_it_is_a_warning_not_an_error(): void {
		$html = $this->render( $this->document( array( 'read_only' => true ) ) );

		$this->assertStringContainsString( 'notice-warning', $html );
		$this->assertStringNotContainsString( 'notice-error', $html );
	}

	/**
	 * 📌 **Silent while the subscription is healthy.** A notice that shows for
	 * everyone is one every merchant learns to dismiss unread.
	 */
	public function test_it_says_nothing_when_the_plan_is_healthy(): void {
		$this->assertSame( '', $this->render( $this->document( array() ) ) );
	}

	/**
	 * 🔴 **Silent during the grace period.** ADR-116 gives fourteen days of
	 * full function; warning on day one explains a restriction the merchant
	 * does not yet have.
	 */
	public function test_it_says_nothing_while_the_grace_period_runs(): void {
		$html = $this->render(
			$this->document(
				array(
					'read_only'     => false,
					'grace_ends_at' => '2026-10-12T00:00:00.000Z',
				)
			)
		);

		$this->assertSame( '', $html );
	}

	/**
	 * ⚠️ **A document written before `plan` existed has no such key**, and a
	 * shop that has not synced since upgrading is exactly that. Absent means
	 * "nothing to say", never "assume the worst".
	 */
	public function test_it_says_nothing_when_the_document_predates_plan_state(): void {
		$document = $this->document( array() );
		unset( $document['plan'] );

		$this->assertSame( '', $this->render( $document ) );
	}

	/** 📌 And a shop that has never synced at all has no document to read. */
	public function test_it_says_nothing_without_a_cached_document(): void {
		$this->assertSame( '', $this->render( null ) );
	}

	/**
	 * 🔴 **Only for someone who can act on it.** A shop manager who cannot
	 * reach billing is told about a problem they cannot fix.
	 */
	public function test_it_is_hidden_from_users_who_cannot_manage(): void {
		$GLOBALS['optionia_test_can'] = false;

		$this->assertSame( '', $this->render( $this->document( array( 'read_only' => true ) ) ) );
	}
}
