<?php
/**
 * The merchant's per-option file rules, and where they actually bind.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadRules;
use PHPUnit\Framework\TestCase;

/**
 * 🔴 **These rules were enforced nowhere on the server.**
 *
 * `accepted_types` reached the page as an `accept` attribute and `max_size_mb`
 * as a data attribute — both client-side only. `accept` is a hint a browser may
 * ignore, and a data attribute is a string an attacker edits or skips entirely
 * by posting straight to `/optionia/v1/upload`.
 *
 * @covers \Optionia\Upload\UploadRules
 */
final class UploadRulesTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
	}

	/**
	 * Cache a document holding one option.
	 *
	 * @param array<string, mixed> $option The option to store.
	 */
	private function cache( array $option ): UploadRules {
		$logger = new Logger( new Settings() );

		( new Repository( $logger ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 1,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(),
						'rules'       => array(),
						'groups'      => array(
							array(
								'id'      => 'g',
								'label'   => 'G',
								'options' => array( $option ),
							),
						),
					),
				),
			),
			'W/"rules"'
		);

		return new UploadRules( new Repository( $logger ) );
	}

	/**
	 * A file option with the given validation rules.
	 *
	 * @param array<string, mixed> $validation Rules.
	 * @param string               $type       Presentation.
	 */
	private function fileOption( array $validation = array(), string $type = 'file_input' ): array {
		return array(
			'id'         => 'opt-f',
			'key'        => 'artwork',
			'type'       => $type,
			'value_kind' => 'file',
			'label'      => 'Artwork',
			'validation' => $validation,
			'values'     => array(),
		);
	}

	public function test_it_finds_a_file_option_by_id(): void {
		$rules = $this->cache( $this->fileOption() );

		$this->assertNotNull( $rules->find( 'opt-f' ) );
	}

	public function test_an_unknown_id_finds_nothing(): void {
		$rules = $this->cache( $this->fileOption() );

		$this->assertNull( $rules->find( 'opt-missing' ) );
		$this->assertNull( $rules->find( '' ) );
	}

	/**
	 * 🔴 **An id naming a radio is refused, not treated as unrestricted.**
	 *
	 * A radio cannot hold a file, so storing bytes against it would create an
	 * upload nothing will ever read — and it is the shape a probe takes when
	 * hunting for an option that skips the file rules.
	 */
	public function test_a_non_file_option_is_refused(): void {
		$rules = $this->cache( $this->fileOption( array(), 'radio' ) );

		$this->assertNull( $rules->find( 'opt-f' ) );
	}

	public function test_no_cached_document_finds_nothing(): void {
		$rules = new UploadRules( new Repository( new Logger( new Settings() ) ) );

		$this->assertNull( $rules->find( 'opt-f' ) );
	}

	public function test_it_reads_the_accepted_types(): void {
		$rules  = $this->cache( $this->fileOption( array( 'accepted_types' => array( 'pdf', 'png' ) ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( array( 'pdf', 'png' ), $rules->accepted_types( $option ) );
	}

	/**
	 * ⚠️ `PDF`, `.pdf` and `pdf` are one rule, not three that disagree.
	 *
	 * The storage layer normalises an extension the same way, so a merchant who
	 * types a leading dot gets the rule they meant rather than one that matches
	 * nothing.
	 */
	public function test_it_normalises_the_merchants_spelling(): void {
		$rules  = $this->cache( $this->fileOption( array( 'accepted_types' => array( '.PDF', 'PnG', ' ai ' ) ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( array( 'pdf', 'png', 'ai' ), $rules->accepted_types( $option ) );
	}

	public function test_it_accepts_a_listed_extension(): void {
		$rules  = $this->cache( $this->fileOption( array( 'accepted_types' => array( 'pdf' ) ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertTrue( $rules->accepts_extension( $option, 'pdf' ) );
		$this->assertTrue( $rules->accepts_extension( $option, 'PDF' ) );
	}

	/**
	 * 🔴 **The rule that could only be bypassed before.**
	 *
	 * A customer posting straight to the route sends whatever filename they
	 * like; the `accept` attribute never reaches the server.
	 */
	public function test_it_refuses_an_unlisted_extension(): void {
		$rules  = $this->cache( $this->fileOption( array( 'accepted_types' => array( 'pdf' ) ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertFalse( $rules->accepts_extension( $option, 'exe' ) );
		$this->assertFalse( $rules->accepts_extension( $option, 'png' ) );
		$this->assertFalse( $rules->accepts_extension( $option, '' ) );
	}

	/**
	 * No list means the merchant did not narrow it — which is not "anything".
	 *
	 * The platform's own allowlist still applies at the content check (M15.3);
	 * this answers only whether the *merchant* restricted the field.
	 */
	public function test_no_list_accepts_any_extension(): void {
		$rules  = $this->cache( $this->fileOption() );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( array(), $rules->accepted_types( $option ) );
		$this->assertTrue( $rules->accepts_extension( $option, 'pdf' ) );
	}

	public function test_it_reads_the_size_ceiling_in_bytes(): void {
		$rules  = $this->cache( $this->fileOption( array( 'max_size_mb' => 20 ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( 20971520, $rules->max_bytes( $option ) );
	}

	/**
	 * Zero means "the merchant set none", so the host's ceiling stands alone.
	 */
	public function test_no_configured_size_reports_zero(): void {
		$rules  = $this->cache( $this->fileOption() );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( 0, $rules->max_bytes( $option ) );
	}

	/** A malformed rule is treated as absent rather than trusted. */
	public function test_a_malformed_size_reports_zero(): void {
		$rules  = $this->cache( $this->fileOption( array( 'max_size_mb' => 'twenty' ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( 0, $rules->max_bytes( $option ) );
	}

	public function test_a_non_array_accepted_types_is_ignored(): void {
		$rules  = $this->cache( $this->fileOption( array( 'accepted_types' => 'pdf' ) ) );
		$option = $rules->find( 'opt-f' );

		$this->assertSame( array(), $rules->accepted_types( $option ) );
	}
}
