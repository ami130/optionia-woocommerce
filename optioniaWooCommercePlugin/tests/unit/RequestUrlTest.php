<?php
/**
 * URL validation on merchant-supplied settings (M8.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\Request;
use PHPUnit\Framework\TestCase;

/**
 * `Request::post_url` and the schemes it admits.
 *
 * @covers \Optionia\Admin\Request
 */
final class RequestUrlTest extends TestCase {

	/**
	 * Reset the POST body.
	 */
	protected function setUp(): void {
		$_POST = array();
	}

	/**
	 * **The credential must never cross plain HTTP.**
	 *
	 * The API base URL is a merchant-facing field described as "leave blank to
	 * use the default". Accepting `http` there meant a merchant pasting a
	 * staging address would send the store credential in clear text on every
	 * request afterwards — and the cloud already refuses an `http://` site at
	 * `initiate` for exactly this reason.
	 */
	public function test_http_is_refused_by_default(): void {
		$_POST['api'] = 'http://api.example.com/v1';

		$this->assertSame( '', Request::post_url( 'api' ) );
	}

	public function test_https_is_accepted(): void {
		$_POST['api'] = 'https://api.example.com/v1';

		$this->assertSame( 'https://api.example.com/v1', Request::post_url( 'api' ) );
	}

	/** A caller may still allow plain HTTP where it is legitimate. */
	public function test_a_caller_may_widen_the_schemes(): void {
		$_POST['api'] = 'http://api.example.com/v1';

		$this->assertSame(
			'http://api.example.com/v1',
			Request::post_url( 'api', array( 'http', 'https' ) )
		);
	}

	/** The original reason this helper exists: no script URLs in a setting. */
	public function test_a_script_url_is_refused(): void {
		$_POST['api'] = 'javascript:alert(1)';

		$this->assertSame( '', Request::post_url( 'api' ) );
		$this->assertSame( '', Request::post_url( 'api', array( 'http', 'https' ) ) );
	}

	public function test_an_empty_field_is_empty(): void {
		$this->assertSame( '', Request::post_url( 'api' ) );
	}
}
