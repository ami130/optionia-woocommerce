import { acceptsLength } from '@/lib/schemas/option-sets';

/**
 * What the customer will see, drawn from the fields the merchant is filling in.
 *
 * 🔴 **Authoring without this is guessing.** Every field in the form describes
 * something invisible until the set is published, assigned to a product and
 * opened on a storefront — four steps away from the decision being made. A
 * merchant choosing between "radio buttons" and "dropdown" is choosing between
 * two pictures they cannot see.
 *
 * ⚠️ **A likeness, not the storefront.** The real markup comes from the plugin's
 * templates and carries pricing, swatch colours and the character counter's live
 * count. This shows shape and copy — enough to answer *"is this the control I
 * meant?"*, which is the question being asked at this moment.
 */
export function OptionPreview({
  label,
  presentation,
  isRequired,
  maxLength,
}: {
  label: string;
  presentation: string;
  isRequired: boolean;
  maxLength: number | null;
}) {
  const shown = label.trim() === '' ? 'Your option' : label;

  const field = () => {
    switch (presentation) {
      case 'dropdown':
        return (
          <select disabled className="bg-background h-9 w-full rounded-md border px-3 text-sm">
            <option>Choose an option</option>
          </select>
        );
      case 'textarea':
        return (
          <textarea
            disabled
            rows={3}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm"
            placeholder="Several lines…"
          />
        );
      case 'hidden':
        /*
         * ⚠️ **The preview shows what the *merchant* sees: nothing.**
         *
         * A hidden field has no customer-facing control at all, and drawing a
         * disabled input would suggest one exists. Saying so plainly is the
         * honest preview.
         */
        return (
          <p className="text-muted-foreground text-sm italic">
            Not shown to the customer — the value you set travels with the order.
          </p>
        );
      case 'date_picker':
        return (
          <input disabled type="date" className="bg-background h-9 rounded-md border px-3 text-sm" />
        );
      case 'time_picker':
        return (
          <input disabled type="time" className="bg-background h-9 rounded-md border px-3 text-sm" />
        );
      case 'datetime_picker':
        return (
          <input
            disabled
            type="datetime-local"
            className="bg-background h-9 rounded-md border px-3 text-sm"
          />
        );
      case 'range':
        return (
          <div className="flex items-center gap-3">
            <input disabled type="range" className="w-full" defaultValue={50} />
            <span className="text-muted-foreground w-8 text-right text-sm">50</span>
          </div>
        );
      case 'quantity':
        return (
          <input
            disabled
            type="number"
            step={1}
            className="bg-background h-9 w-24 rounded-md border px-3 text-sm"
            placeholder="1"
          />
        );
      case 'number_field':
        return (
          <input
            disabled
            type="number"
            className="bg-background h-9 w-full rounded-md border px-3 text-sm"
            placeholder="0"
          />
        );
      /*
       * ⚠️ **Shown as a picker, not as the upload it becomes.**
       *
       * On the storefront this control uploads over the network and swaps in a
       * progress readout and a token. None of that belongs in a merchant's
       * preview: what they are choosing is "the customer attaches a file", and a
       * fake progress bar would imply an upload this pane cannot perform.
       */
      case 'file_input':
        return (
          <div className="bg-background flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="text-muted-foreground">📎</span>
            <span className="text-muted-foreground">Choose a file…</span>
          </div>
        );
      case 'text_field':
        return (
          <input
            disabled
            className="bg-background h-9 w-full rounded-md border px-3 text-sm"
            placeholder="Type here…"
          />
        );
      case 'color_swatch':
        return (
          <div className="flex gap-2">
            {['#cc0000', '#001f5b', '#0a7d3f'].map((hex) => (
              <span
                key={hex}
                className="size-7 rounded-full border"
                style={{ backgroundColor: hex }}
                aria-hidden="true"
              />
            ))}
          </div>
        );
      case 'image_swatch':
        return (
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <span key={i} className="bg-muted size-9 rounded border" aria-hidden="true" />
            ))}
          </div>
        );
      case 'checkbox':
        return (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled className="size-4" /> Yes please
          </label>
        );
      default:
        return (
          <div className="space-y-1.5">
            {['First choice', 'Second choice'].map((choice) => (
              <label key={choice} className="flex items-center gap-2 text-sm">
                <input type="radio" disabled className="size-4" /> {choice}
              </label>
            ))}
          </div>
        );
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">
        {shown}
        {isRequired ? <span className="text-destructive"> *</span> : null}
      </p>
      {field()}
      {maxLength !== null && acceptsLength(presentation) ? (
        <p className="text-muted-foreground text-xs">0/{maxLength}</p>
      ) : null}
    </div>
  );
}
