<?php
/**
 * Minimal service container.
 *
 * Deliberately not a full DI framework. Its whole job is to make dependencies
 * explicit and lazily constructed, so that Principle 1's layering is visible in
 * one file: read this and you can see exactly what depends on what.
 *
 * Services are registered as factories and built on first use, so a request
 * that never touches the API client never constructs one.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia;

use Optionia\Exceptions\InvariantViolation;

defined( 'ABSPATH' ) || exit;

/**
 * Lazy service locator keyed by class name.
 */
final class Container {

	/**
	 * Factories keyed by service id.
	 *
	 * @var array<string, callable>
	 */
	private array $factories = array();

	/**
	 * Constructed instances keyed by service id.
	 *
	 * @var array<string, object>
	 */
	private array $instances = array();

	/**
	 * Register a factory.
	 *
	 * @param string   $id      Service id, conventionally a class name.
	 * @param callable $factory Receives the container, returns the service.
	 */
	public function set( string $id, callable $factory ): void {
		$this->factories[ $id ] = $factory;
	}

	/**
	 * Resolve a service, constructing it once.
	 *
	 * @param string $id Service id.
	 * @return object
	 * @throws InvariantViolation When the id was never registered.
	 */
	public function get( string $id ): object {
		if ( isset( $this->instances[ $id ] ) ) {
			return $this->instances[ $id ];
		}

		if ( ! isset( $this->factories[ $id ] ) ) {
			// Exception messages are developer-facing and never rendered to a page.
			throw new InvariantViolation( sprintf( 'Service "%s" is not registered.', $id ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
		}

		$service = ( $this->factories[ $id ] )( $this );

		if ( ! is_object( $service ) ) {
			// Exception messages are developer-facing and never rendered to a page.
			throw new InvariantViolation( sprintf( 'Factory for "%s" did not return an object.', $id ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
		}

		$this->instances[ $id ] = $service;

		return $service;
	}

	/**
	 * Whether a service is registered.
	 *
	 * @param string $id Service id.
	 */
	public function has( string $id ): bool {
		return isset( $this->factories[ $id ] ) || isset( $this->instances[ $id ] );
	}
}
