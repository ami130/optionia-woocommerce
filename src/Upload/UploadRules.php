<?php
/**
 * The merchant's rules for one file option, read from the cached document.
 *
 * ## Why this exists at all
 *
 * 🔴 **The rules were enforced nowhere on the server.** `accepted_types` reached
 * the markup as an `accept` attribute and `max_size_mb` as a data attribute, and
 * both are **client-side only**: `accept` is a hint a browser may ignore, and a
 * data attribute is a string an attacker edits or skips entirely by posting
 * straight to `/optionia/v1/upload`.
 *
 * That is AC4's rule — *the browser is an untrusted input device* — on a surface
 * that did not yet honour it. A merchant who restricted an artwork field to PDF
 * had configured something no code checked.
 *
 * ## Why a class rather than a lookup inside the endpoint
 *
 * The endpoint would otherwise need to walk sets → groups → options itself, which
 * is the traversal `Engine\SelectionResolver::index_options()` already owns for a
 * different purpose. Two walks of the same tree drift — the presentational-items
 * duplication bug in Phase 14 was exactly that, twice over — so this is one small
 * seam with one job: *given an option id, what did the merchant ask for?*
 *
 * ⚠️ **A missing option means no rules, not permissive rules.** An upload naming
 * an option this store does not have is either a stale page or a probe, and both
 * are refused by the caller rather than defaulted through.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Config\Repository;

defined( 'ABSPATH' ) || exit;

/**
 * What a merchant configured for one file option.
 */
final class UploadRules {

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Build the reader over the cached configuration.
	 *
	 * @param Repository $config Configuration cache.
	 */
	public function __construct( Repository $config ) {
		$this->config = $config;
	}

	/**
	 * The option with this id, or null.
	 *
	 * ⚠️ **Only a `file_input` option is returned.** An id naming a radio is not
	 * "an option with no file rules" — it is a request to attach a file to
	 * something that cannot hold one, and answering null makes the caller refuse
	 * rather than store an orphan nothing will ever read.
	 *
	 * @param string $option_id The id the browser sent.
	 * @return array<string, mixed>|null
	 */
	public function find( string $option_id ): ?array {
		if ( '' === $option_id ) {
			return null;
		}

		$document = $this->config->get();

		if ( ! is_array( $document ) || ! isset( $document['option_sets'] ) ) {
			return null;
		}

		foreach ( (array) $document['option_sets'] as $set ) {
			foreach ( (array) ( $set['groups'] ?? array() ) as $group ) {
				foreach ( (array) ( $group['options'] ?? array() ) as $option ) {
					if ( ! is_array( $option ) || ! isset( $option['id'] ) || ! is_scalar( $option['id'] ) ) {
						continue;
					}

					if ( (string) $option['id'] !== $option_id ) {
						continue;
					}

					$type = isset( $option['type'] ) ? (string) $option['type'] : '';

					return 'file_input' === $type ? $option : null;
				}
			}
		}

		return null;
	}

	/**
	 * Extensions this option accepts, lowercase and without a dot.
	 *
	 * An empty array means the merchant set no restriction, which is **not** the
	 * same as "anything": the platform's own allowlist still applies at the
	 * content check (M15.3). This answers only *"did the merchant narrow it?"*
	 *
	 * @param array<string, mixed> $option A file option from `find()`.
	 * @return array<int, string>
	 */
	public function accepted_types( array $option ): array {
		$rules = isset( $option['validation'] ) && is_array( $option['validation'] )
			? $option['validation']
			: array();

		if ( ! isset( $rules['accepted_types'] ) || ! is_array( $rules['accepted_types'] ) ) {
			return array();
		}

		$types = array();

		foreach ( $rules['accepted_types'] as $type ) {
			if ( ! is_scalar( $type ) ) {
				continue;
			}

			/*
			 * Normalised the same way the storage layer normalises an extension,
			 * so `PDF`, `.pdf` and `pdf` are one rule rather than three that
			 * disagree.
			 */
			$clean = preg_replace( '/[^a-z0-9]/', '', strtolower( (string) $type ) );

			if ( '' !== (string) $clean ) {
				$types[] = (string) $clean;
			}
		}

		return $types;
	}

	/**
	 * Whether this option accepts a file with this extension.
	 *
	 * ⚠️ **Compares the extension the *customer* sent**, which is a claim rather
	 * than a fact. It is the cheap check that runs first; M15.3's content
	 * verification is what decides whether the bytes agree with the claim, and
	 * neither is sufficient alone.
	 *
	 * @param array<string, mixed> $option    A file option from `find()`.
	 * @param string               $extension The uploaded file's extension.
	 */
	public function accepts_extension( array $option, string $extension ): bool {
		$accepted = $this->accepted_types( $option );

		if ( array() === $accepted ) {
			return true;
		}

		$clean = preg_replace( '/[^a-z0-9]/', '', strtolower( $extension ) );

		return '' !== (string) $clean && in_array( (string) $clean, $accepted, true );
	}

	/**
	 * The option's size ceiling in bytes, or zero when the merchant set none.
	 *
	 * ⚠️ **Not the effective limit.** `UploadLimits::effective_max_bytes()` takes
	 * the lower of this and the host's own `upload_max_filesize`, because a
	 * document written against a generous host must not authorise an upload a
	 * modest one truncates. Returning the merchant's number alone here keeps the
	 * two ceilings distinguishable — ADR-041's whole point.
	 *
	 * @param array<string, mixed> $option A file option from `find()`.
	 */
	public function max_bytes( array $option ): int {
		$rules = isset( $option['validation'] ) && is_array( $option['validation'] )
			? $option['validation']
			: array();

		if ( ! isset( $rules['max_size_mb'] ) || ! is_numeric( $rules['max_size_mb'] ) ) {
			return 0;
		}

		$mb = (int) $rules['max_size_mb'];

		return $mb > 0 ? $mb * 1048576 : 0;
	}

	/**
	 * The option's megapixel ceiling, or zero when the merchant set none.
	 *
	 * ⚠️ **Zero means "use the default", not "unlimited".**
	 * `UploadImage::DEFAULT_MAX_MEGAPIXELS` is sized for a 128 MB host, because a
	 * default sized for a generous one fatals on a modest one — and the failure
	 * lands on a customer mid-purchase.
	 *
	 * A float rather than an int: 0.5 MP is a legitimate ceiling for a small logo
	 * field, and rounding it to zero would silently mean "no limit configured".
	 *
	 * @param array<string, mixed> $option A file option from `find()`.
	 */
	public function max_megapixels( array $option ): float {
		$rules = isset( $option['validation'] ) && is_array( $option['validation'] )
			? $option['validation']
			: array();

		if ( ! isset( $rules['max_megapixels'] ) || ! is_numeric( $rules['max_megapixels'] ) ) {
			return 0.0;
		}

		$mp = (float) $rules['max_megapixels'];

		return $mp > 0 ? $mp : 0.0;
	}
}
