<?php
/**
 * Renders option sets onto a product page (M10.2, M10.5).
 *
 * ## Why the hook differs by product type
 *
 * Verified in WooCommerce 11.0.1, and re-verified on the running store:
 * `woocommerce_before_add_to_cart_button` fires directly in `simple.php`,
 * `grouped.php` and `external.php`, and **not at all** in `variable.php`. There
 * it reaches the page only through `variation-add-to-cart-button.php`, inside
 * `single_variation_wrap` — the element `add-to-cart-variation.js` empties and
 * rewrites on every variation change. Options rendered there vanish the moment a
 * customer picks a size.
 *
 * So a variable product renders at `woocommerce_after_variations_table`, which
 * fires **outside** that wrap. Measured on the rendered page for a real variable
 * product: the form opens at byte 60272 and `single_variation_wrap` at 65737, so
 * the hook lands between them.
 *
 * ## Why one hook per type, rather than one callback on several
 *
 * Phase 4 saw a variable product render twice and recorded the symptom without
 * the cause. The cause was the probe registering a single callback on **both**
 * hooks: on a variable product both fire, once outside the wrap and once inside
 * it. Dispatching per type removes the collision rather than papering over it —
 * an idempotence guard alone would have hidden a wrong hook choice instead of
 * preventing it.
 *
 * The guard is still here, because themes and page builders re-fire hooks and a
 * duplicated block is a visible bug. It is a safety net, not the mechanism.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Frontend;

use Optionia\Config\Repository;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Server-rendered option markup, per product type.
 */
final class Renderer {

	/**
	 * Product types this renderer draws options for.
	 *
	 * `external` is absent deliberately: the hook fires on an external product,
	 * so without naming the supported types explicitly Optionia would render
	 * options on a product that links offsite and can never be added to a cart.
	 *
	 * `grouped` is absent for a structural reason rather than a scoping one. In
	 * `grouped.php` the button hook fires *after* the children loop, so options
	 * would appear once at the foot of the table with nothing tying them to a
	 * child — and each child is its own cart line. A block that cannot map to a
	 * line item is worse than no block, so grouped renders nothing until a hook
	 * inside the loop is used, which belongs with the cart work.
	 */
	private const SUPPORTED_TYPES = array( 'simple', 'variable' );

	/**
	 * The group layouts this build has a rendering for.
	 *
	 * 🔴 **Three of `GroupDisplayType`'s four values** (ADR-063). `stepped` is
	 * published and enumerated but ships in its own stage, because a wizard
	 * collides with the rule runtime's visibility model rather than merely
	 * costing more work.
	 *
	 * ⚠️ **A whitelist, so an unknown value falls back to `inline`** rather
	 * than rendering nothing. The document is input, not authority (AC4), and a
	 * group that vanished because its *presentation* was unfamiliar would lose
	 * a sale over a stylesheet.
	 */
	private const DRAWN_DISPLAY_TYPES = array( 'inline', 'accordion', 'tabs' );

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Template loader.
	 *
	 * @var Templates
	 */
	private Templates $templates;

	/**
	 * Asset enqueuer.
	 *
	 * @var Assets
	 */
	private Assets $assets;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Products already rendered this request.
	 *
	 * @var array<int, true>
	 */
	private array $rendered = array();

	/**
	 * Build a renderer over the cache, the template loader and the asset queue.
	 *
	 * @param Repository $config    Configuration cache.
	 * @param Templates  $templates Template loader.
	 * @param Assets     $assets    Asset enqueuer.
	 * @param Logger     $logger    Logger.
	 */
	public function __construct( Repository $config, Templates $templates, Assets $assets, Logger $logger ) {
		$this->config    = $config;
		$this->templates = $templates;
		$this->assets    = $assets;
		$this->logger    = $logger;
	}

	/**
	 * Register the per-type hooks.
	 *
	 * Both point at the same method because the *decision* about which products
	 * to draw belongs in one place — but they are separate registrations, so a
	 * variable product reaches this once, from the hook that survives a
	 * variation change, rather than twice from two hooks that both fire.
	 */
	public function register(): void {
		add_action( 'woocommerce_before_add_to_cart_button', array( $this, 'render' ) );
		add_action( 'woocommerce_after_variations_table', array( $this, 'render' ) );
	}

	/**
	 * Echo the option markup for the product being displayed.
	 */
	public function render(): void {
		$product = $this->current_product();

		if ( null === $product ) {
			return;
		}

		$product_id = (int) $product->get_id();
		$type       = (string) $product->get_type();

		if ( ! $this->renders_for_type( $type, $product_id ) ) {
			return;
		}

		/*
		 * The idempotence guard, checked before any work.
		 *
		 * Both hooks are registered, and on a variable product
		 * `before_add_to_cart_button` fires inside `single_variation_wrap` after
		 * `after_variations_table` has already drawn. Per-type dispatch decides
		 * *which* hook is correct; this decides that a second arrival changes
		 * nothing, whichever theme or page builder caused it.
		 */
		if ( isset( $this->rendered[ $product_id ] ) ) {
			return;
		}

		$sets = $this->config->option_sets_for_product( $product_id );

		if ( array() === $sets ) {
			// No options: no markup, no assets, no trace. A product with nothing
			// configured must look exactly as it did before the plugin existed.
			return;
		}

		$this->rendered[ $product_id ] = true;

		$this->assets->enqueue_frontend();

		/*
		 * Rules travel with the page, after the enqueue that registers the
		 * handle they attach to. Per product, because a page may render several
		 * and `enqueue_frontend()` is idempotent — see `publish_rules()`.
		 */
		$this->assets->publish_rules( $product_id, $sets );

		// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- every template escapes its own output; this is assembled markup.
		echo $this->templates->render(
			'partials/option-sets.php',
			array(
				'product_id' => $product_id,
				'groups'     => $this->groups_with_markup( $sets ),
			)
		);
		// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	/**
	 * Flatten the sets into groups, each option and item pre-rendered.
	 *
	 * **Option markup is built here, not inside the group template.** A template
	 * receives a prepared view-model and nothing else — `Frontend\Templates`
	 * exposes only `$optionia`, so a template that wanted to render a child
	 * template would need the loader in scope, and handing templates a service
	 * is how a view file becomes a controller.
	 *
	 * One template per option type is still the goal, and it holds: the type
	 * decides which file renders each control, so the library added in Phase 14
	 * extends this by adding files rather than editing a switch. The dispatch
	 * simply happens on this side of the boundary.
	 *
	 * ## Why options and items interleave rather than concatenate
	 *
	 * 🔴 **A heading's only job is to sit above the right control.** Both lists
	 * carry `sort_order` on the same scale, and the merchant orders them as one
	 * sequence in the dashboard. Rendering all options then all items — or the
	 * reverse — would put every heading in a block at one end, which is not a
	 * layout anyone asked for and silently discards the merchant's ordering.
	 *
	 * The sort is **stable**: `usort` is not, so ties are broken by the entry's
	 * original index. Without that, two entries sharing a `sort_order` could
	 * swap between requests and a page would render differently on refresh.
	 *
	 * @param array<int, array<string, mixed>> $sets Published option sets.
	 * @return array<int, array<string, mixed>>
	 */
	private function groups_with_markup( array $sets ): array {
		$groups = array();
		$seq    = 0;

		foreach ( $sets as $set ) {
			$set_groups = isset( $set['groups'] ) && is_array( $set['groups'] ) ? $set['groups'] : array();

			foreach ( $set_groups as $group ) {
				$markup = $this->group_markup( $group );

				if ( '' === $markup ) {
					// A group that draws nothing renders nothing rather than an
					// empty fieldset, which a screen reader would announce.
					continue;
				}

				/*
				 * 🔴 **The `id` is carried for M17.9, and nothing else reads it.**
				 * A rule may target a group, and the storefront runtime resolves
				 * a target by id — so a group without one in the DOM is a rule
				 * the page cannot apply, however correctly the evaluator decided
				 * it.
				 *
				 * Options have carried theirs since Phase 10; groups did not,
				 * because until rules existed nothing on the page needed to name
				 * a group.
				 */
				$groups[] = array(

					/*
					 * 🔴 **Carried so the groups can be SORTED, which nothing
					 * did before M18.8b.**
					 *
					 * `sort_order` has been published on every group since
					 * Phase 5 and read by nothing here — this loop walked the
					 * array as it arrived. Ordering worked only because the
					 * repository queries `ASC` and the serializer preserves
					 * that, which is a **convention** rather than a guarantee,
					 * and AC4 makes the document input rather than authority.
					 *
					 * ⚠️ **It was also the last published field read by
					 * nothing** — the ADR-055 shape this phase withdrew three
					 * fields for, sitting on the very field M18.6 exists to let
					 * a merchant control.
					 */
					'sort'           => $this->sort_order( $group ),
					'seq'            => $seq++,
					'id'             => isset( $group['id'] ) && is_scalar( $group['id'] ) ? (string) $group['id'] : '',
					'label'          => isset( $group['label'] ) ? (string) $group['label'] : '',
					'description'    => isset( $group['description'] ) ? (string) $group['description'] : '',
					'display_type'   => self::display_type_of( $group ),

					/*
					 * 🔴 **Only an `inline` group may be folded** (ADR-059).
					 *
					 * An accordion is already collapsible and a tab already
					 * hides its siblings, so honouring the flag there would give
					 * two fields one job — and let a merchant publish
					 * `accordion` with `is_collapsible: false`, a contradiction
					 * no rendering can satisfy. Resolved here rather than in the
					 * template, so one answer reaches every consumer.
					 */
					'is_collapsible' => 'inline' === self::display_type_of( $group )
						&& ! empty( $group['is_collapsible'] ),

					/*
					 * 🔴 **A group holding a required option must not start
					 * CLOSED**, or the customer cannot reach what the browser
					 * refuses to submit without.
					 *
					 * Measured: a `required` control inside a closed
					 * `<details>` reports `willValidate: true` and
					 * `form.checkValidity() === false`, while `details.open` is
					 * `false` — so the form blocks on a field nobody can see.
					 * Chrome and Firefox usually expand the disclosure to show
					 * the message, but that is a courtesy behaviour rather than
					 * a guarantee, and it is not one to stake an add-to-cart on.
					 *
					 * ⚠️ **Opened, not un-folded.** The merchant asked for an
					 * accordion and still gets one — it simply starts open, the
					 * way a collapsible `inline` group already does. Refusing to
					 * fold at all would discard a choice they made; starting
					 * open honours it and keeps the product buyable.
					 *
					 * 📌 **This is the same dead end ADR-060 recorded**, reached
					 * from a third direction: there the renderer skipped an
					 * option the resolver still demanded. The rule is the same
					 * one — what the page shows and what submission requires
					 * must agree.
					 */
					'starts_open'    => self::holds_a_required_option( $group ),
					'options'        => $markup,
				);
			}
		}

		/*
		 * Stable, for the reason the entry sort inside a group records: two
		 * groups sharing a `sort_order` could otherwise swap between requests
		 * and a page would render differently on refresh.
		 *
		 * ⚠️ **The tiebreak is load-bearing on PHP 7.4 and dead weight on 8.**
		 * `usort` became stable in PHP 8.0; this plugin supports **7.4**
		 * (`OPTIONIA_MIN_PHP`), so the guard is real for the oldest stores it
		 * runs on — and **a mutation test cannot prove it**, because the test
		 * runtime is 8.4 and sorts stably with or without it. Recorded rather
		 * than deleted as an equivalent mutant: it is equivalent *here*, not
		 * where it matters.
		 *
		 * ⚠️ **Sorted across ALL sets, not within each.** A product may be
		 * assigned several option sets, and a merchant ordering their groups
		 * sees one sequence — sorting per set would render them in blocks by
		 * set, which is the shape the entry sort above rejects for options and
		 * items.
		 */
		usort(
			$groups,
			static function ( array $a, array $b ): int {
				$by_order = $a['sort'] <=> $b['sort'];

				return 0 !== $by_order ? $by_order : ( $a['seq'] <=> $b['seq'] );
			}
		);

		return $groups;
	}

	/**
	 * One group's controls and presentational items, in the merchant's order.
	 *
	 * Returns `''` when the group draws nothing at all — no options, no items,
	 * or every entry unrenderable — so the caller can drop the fieldset.
	 *
	 * ⚠️ **A group of only dividers still counts as drawing something.** That is
	 * odd markup, but it is what the merchant authored, and silently dropping it
	 * would make a real configuration invisible with no error anywhere.
	 *
	 * @param array<string, mixed> $group One published group.
	 */
	private function group_markup( array $group ): string {
		$options = isset( $group['options'] ) && is_array( $group['options'] ) ? $group['options'] : array();
		$items   = isset( $group['items'] ) && is_array( $group['items'] ) ? $group['items'] : array();

		$entries = array();
		$index   = 0;

		foreach ( $options as $option ) {
			if ( is_array( $option ) ) {
				$entries[] = array(
					'sort' => $this->sort_order( $option ),
					'seq'  => $index++,
					'kind' => 'option',
					'data' => $option,
				);
			}
		}

		foreach ( $items as $item ) {
			if ( is_array( $item ) ) {
				$entries[] = array(
					'sort' => $this->sort_order( $item ),
					'seq'  => $index++,
					'kind' => 'item',
					'data' => $item,
				);
			}
		}

		// Stable: `usort` is not, so equal sort orders fall back to arrival.
		usort(
			$entries,
			static function ( array $a, array $b ): int {
				$by_order = $a['sort'] <=> $b['sort'];

				return 0 !== $by_order ? $by_order : ( $a['seq'] <=> $b['seq'] );
			}
		);

		$markup = '';

		foreach ( $entries as $entry ) {
			$markup .= 'option' === $entry['kind']
				? $this->option_markup( $entry['data'] )
				: $this->item_markup( $entry['data'] );
		}

		return $markup;
	}

	/**
	 * An entry's position, defaulting to the end rather than the start.
	 *
	 * A document missing `sort_order` is either malformed or from an older
	 * schema. Defaulting to `0` would hoist those entries above everything the
	 * merchant *did* order; `PHP_INT_MAX` leaves the deliberate ordering intact
	 * and appends the rest.
	 *
	 * @param array<string, mixed> $entry Option or presentational item.
	 */
	private function sort_order( array $entry ): int {
		return isset( $entry['sort_order'] ) && is_numeric( $entry['sort_order'] )
			? (int) $entry['sort_order']
			: PHP_INT_MAX;
	}

	/**
	 * One presentational item, rendered by its kind template.
	 *
	 * An unknown kind renders **nothing** and is logged, for the same reason an
	 * unknown option type does: a plugin can legitimately be one release behind
	 * the cloud that published the document. `rich_text` reaches here only from a
	 * document written by a future build — the authoring API refuses it today —
	 * and having no template is exactly the right outcome, because rendering
	 * merchant markup without the sanitizer M5.4c requires is the one mistake
	 * this feature must not make.
	 *
	 * @param array<string, mixed> $item One published presentational item.
	 */
	private function item_markup( array $item ): string {
		$kind = isset( $item['kind'] ) ? (string) $item['kind'] : '';

		if ( '' === $kind ) {
			return '';
		}

		$markup = $this->templates->render(
			'presentational/' . sanitize_key( $kind ) . '.php',
			array( 'item' => $item )
		);

		if ( '' === $markup ) {
			$this->logger->debug(
				'No template for presentational item kind; skipped.',
				array( 'kind' => $kind )
			);
		}

		return $markup;
	}

	/**
	 * Whether any option in this group must be answered.
	 *
	 * 🔴 **Read from the published document, not from the rendered markup.**
	 * A rule may make an option required at runtime too — `frontend.js` applies
	 * that — but a rule cannot fire before the page loads, so the authored
	 * answer is the one that decides how the group opens. A group a rule later
	 * makes required is already visible, because the customer had to answer
	 * something for the rule to fire.
	 *
	 * @param array<string, mixed> $group One published group.
	 */
	private static function holds_a_required_option( array $group ): bool {
		$options = isset( $group['options'] ) && is_array( $group['options'] ) ? $group['options'] : array();

		foreach ( $options as $option ) {
			if ( is_array( $option ) && ! empty( $option['is_required'] ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * A group's layout, as one of the values this build can draw.
	 *
	 * 🔴 **Anything unrecognised renders as `inline`**, which is the safe
	 * direction and the same one `SelectionResolver::takes_many()` takes for an
	 * unknown cardinality. A document from a newer cloud naming a layout this
	 * build has no template for must still render its options — a group that
	 * vanished because its *presentation* was unfamiliar would lose the
	 * merchant a sale over a stylesheet.
	 *
	 * ⚠️ **`stepped` is deliberately in that fallback** (ADR-063). It is a
	 * published value with a stage of its own, not an unknown one: a wizard
	 * needs a second reason for a group to be hidden, and `frontend.js`
	 * recomputes visibility from scratch on every change — so *"hidden because
	 * a rule fired"* and *"hidden because this is not the current step"* would
	 * share one attribute and the first keystroke would reveal every step.
	 *
	 * The dashboard does not offer `stepped` while this is true, so a merchant
	 * cannot select a layout that silently behaves like another.
	 *
	 * @param array<string, mixed> $group One published group.
	 */
	private static function display_type_of( array $group ): string {
		$type = isset( $group['display_type'] ) && is_scalar( $group['display_type'] )
			? (string) $group['display_type']
			: '';

		return in_array( $type, self::DRAWN_DISPLAY_TYPES, true ) ? $type : 'inline';
	}

	/**
	 * One option's control, rendered by its type template.
	 *
	 * An unknown type renders **nothing** and is logged. Phase 14 builds the
	 * type library, so a document can legitimately name a type this build has no
	 * template for — a plugin one release behind its cloud. Rendering a fallback
	 * control would be worse than rendering none: a customer could select a
	 * value the plugin does not understand and the server would price it wrong.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private function option_markup( array $option ): string {
		$type = isset( $option['type'] ) ? (string) $option['type'] : '';

		if ( '' === $type ) {
			return '';
		}

		$markup = $this->templates->render(
			'options/' . sanitize_key( $type ) . '.php',
			array(
				'option'     => $option,
				'field_name' => Keys::FIELD_PREFIX,
			)
		);

		if ( '' === $markup ) {
			$this->logger->debug(
				'No template for option type; skipped.',
				array(
					'type'      => $type,
					'option_id' => isset( $option['id'] ) ? (string) $option['id'] : '',
				)
			);
		}

		return $markup;
	}

	/**
	 * Whether this product type gets options, logging what was skipped.
	 *
	 * @param string $type       Product type.
	 * @param int    $product_id Product id, for the log entry.
	 */
	private function renders_for_type( string $type, int $product_id ): bool {
		if ( in_array( $type, self::SUPPORTED_TYPES, true ) ) {
			return true;
		}

		/*
		 * Debug rather than warning: an external or grouped product with no
		 * options is the expected case, not a fault, and a merchant's log should
		 * not fill with it. The entry exists so "why are my options missing on
		 * this product?" has an answer.
		 */
		$this->logger->debug(
			'Skipped rendering options for an unsupported product type.',
			array(
				'product_id' => $product_id,
				'type'       => $type,
			)
		);

		return false;
	}

	/**
	 * The product currently being displayed, or null.
	 *
	 * Read from the global rather than passed in: the hooks this registers on
	 * take no arguments, and `$product` is what WooCommerce's own templates use
	 * at exactly these points.
	 *
	 * @return \WC_Product|null
	 */
	private function current_product() {
		global $product;

		if ( ! is_object( $product ) || ! method_exists( $product, 'get_id' ) || ! method_exists( $product, 'get_type' ) ) {
			return null;
		}

		return $product;
	}
}
