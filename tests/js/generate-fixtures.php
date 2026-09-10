<?php
/**
 * Render every option template to real markup, for the JavaScript tests.
 *
 * ## Why this exists
 *
 * The contract tests need to know **which element carries which attribute** —
 * that is the distinction the dropdown £0 bug turned on. Reading it out of the
 * PHP source with a regex does not work: the attributes sit inside
 * `<?php if ( … ) : ?>` blocks, so any `[^>]*` pattern stops at the `?>` and
 * matches nothing. A test built that way reports "no price attribute" for a
 * template full of them.
 *
 * So the markup is produced by the **real renderer**, exactly as a browser
 * receives it, and written where Vitest can read it. Generated rather than
 * committed, so it cannot drift from the templates.
 *
 * @package Optionia
 */

declare( strict_types=1 );

require __DIR__ . '/../bootstrap.php';

use Optionia\Config\Repository;
use Optionia\Frontend\Assets;
use Optionia\Frontend\Renderer;
use Optionia\Frontend\Templates;
use Optionia\Support\Logger;
use Optionia\Support\Settings;

/**
 * One published option of the given type, priced.
 *
 * @param string               $type   Presentation.
 * @param array<string, mixed> $extras Extra option fields.
 * @return array<string, mixed>
 */
function optionia_fixture_option( string $type, array $extras = array() ): array {
	// Types whose value the customer supplies rather than choosing from a list.
	$takes_values = ! in_array( $type, array( 'text_field', 'textarea', 'number_field', 'range', 'quantity', 'date_picker', 'time_picker', 'datetime_picker', 'hidden' ), true );

	$values = $takes_values
		? array(
			array(
				'value_key'    => 'lux',
				'label'        => 'Luxury',
				'price_config' => array(
					'type'         => 'fixed',
					'amount_minor' => 1050,
				),
			),
		)
		: array();

	return array_merge(
		array(
			'id'          => 'opt-' . $type,
			'key'         => 'finish',
			'type'        => $type,
			'label'       => 'Finish',
			'is_required' => true,
			'values'      => $values,
		),
		$extras
	);
}

/**
 * Render every type and write the fixture file.
 *
 * Wrapped in a function rather than run at file scope: PHPCS requires globals to
 * carry the plugin prefix, and a CLI script's locals are not globals in any
 * meaningful sense. A function is the honest fix — prefixing `$out` would have
 * silenced the sniff without making anything clearer.
 */
function optionia_render_fixtures(): void {
	$logger = new Logger( new Settings() );

	/*
	 * Every authorable type, so the contract tests compare against the real
	 * markup of each. A type missing here is one whose roles the JS could query
	 * without anything noticing.
	 */
	$types = array(
		'radio',
		'dropdown',
		'checkbox',
		'color_swatch',
		'image_swatch',
		'text_field',
		'textarea',
		'number_field',
		'range',
		'quantity',

		'date_picker',
		'time_picker',
		'datetime_picker',
		'hidden',

		// M15.2: the first type whose control is driven by a network call.
		'file_input',
	);
	$out   = array();

	foreach ( $types as $type ) {
		$option = optionia_fixture_option( $type );

		// Swatches paint from a value field, so give them one.
		if ( 'color_swatch' === $type ) {
			$option['values'][0]['color_hex'] = '#aabbcc';
		}

		if ( 'image_swatch' === $type ) {
			$option['values'][0]['image_url'] = 'https://store.test/a.png';
		}

		if ( 'text_field' === $type || 'textarea' === $type ) {
			$option['validation'] = array( 'max_length' => 20 );
			$option['display']    = array( 'character_counter' => true );
		}

		// A slider's bounds are required, so the fixture must carry them.
		if ( 'range' === $type ) {
			$option['validation'] = array(
				'min'  => 10,
				'max'  => 50,
				'step' => 5,
			);
		}

		if ( 'number_field' === $type || 'quantity' === $type ) {
			$option['validation'] = array(
				'min' => 1,
				'max' => 100,
			);
		}

		if ( 'hidden' === $type ) {
			$option['default_value'] = 'batch-77';
		}

		if ( 'date_picker' === $type ) {
			$option['validation'] = array(
				'min_date' => '2026-01-01',
				'max_date' => '2026-12-31',
			);
		}

		( new Repository( $logger ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array( $option ),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);

		$GLOBALS['product'] = optionia_test_product( 20, 'simple' );

		ob_start();
		( new Renderer( new Repository( $logger ), new Templates( $logger ), new Assets(), $logger ) )->render();
		$markup = (string) ob_get_clean();

		/*
		 * A template that renders nothing would produce a fixture the contract
		 * tests then read as "this type emits no price attribute" — passing for
		 * the worst possible reason. Fail loudly instead.
		 */
		if ( '' === trim( $markup ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite -- a CLI script with no WordPress bootstrap; WP_Filesystem does not exist here.
			fwrite( STDERR, "Rendered nothing for {$type}\n" );
			exit( 1 );
		}

		$out[ $type ] = $markup;
	}

	// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- as above: no WordPress, no WP_Filesystem.
	file_put_contents(
		__DIR__ . '/rendered-fixtures.json',
		(string) wp_json_encode( $out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE )
	);

	printf( "Rendered %d template(s).\n", count( $out ) );
}

optionia_render_fixtures();
