import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

import { AssignmentTargetType } from '../../common/database/enums';
import { AssignTargetsDto } from './assign-product.dto';

/**
 * The assignment request body, through the real pipe (M19.1').
 *
 * 🔴 **Constructed with the settings `main.ts` uses**, not defaults. `whitelist`
 * and `forbidNonWhitelisted` are what make the legacy-shape support delicate:
 * they strip and then reject unknown properties, so a `@Transform` that read the
 * typed value rather than the raw body would never see `externalProductIds`.
 * A pipe built with defaults here would pass while production rejected the
 * request — the test would be green for the wrong reason.
 */
describe('AssignTargetsDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: AssignTargetsDto,
    data: '',
  };

  const run = (body: unknown): Promise<AssignTargetsDto> =>
    pipe.transform(body, metadata) as Promise<AssignTargetsDto>;

  describe('the M19.1 shape', () => {
    it('accepts every authorable target type', async () => {
      const dto = await run({
        targets: [
          { targetType: 'product', targetRef: 'wc-1' },
          { targetType: 'category', targetRef: 'summer' },
          { targetType: 'tag', targetRef: 'sale' },
          { targetType: 'attribute', targetRef: 'pa_color:red' },
          { targetType: 'price_range', targetRef: '10-20' },
        ],
      });

      expect(dto.targets.map((target) => target.targetType)).toEqual([
        'product',
        'category',
        'tag',
        'attribute',
        'price_range',
      ]);
    });

    it('rejects an unknown target type', async () => {
      await expect(
        run({ targets: [{ targetType: 'nonsense', targetRef: 'x' }] }),
      ).rejects.toThrow();
    });

    /*
     * ⚠️ **`conditional` is an `AssignmentMode`, not a target type** — it is not
     * in `AssignmentTargetType` at all. This asserts that authoring a *mode*
     * where a target type belongs is refused, which is the confusion the two
     * vocabularies invite; it is not evidence that the authoring list is
     * narrower than the enum. Today it is not: both hold the same five values,
     * so `@IsIn(ASSIGNABLE_TARGET_TYPES)` and `@IsIn(enum)` behave identically
     * and no test can separate them. The narrower list is kept as the seam that
     * makes them separable the moment a stored-but-not-authorable type appears.
     */
    it('rejects an assignment mode used as a target type', async () => {
      await expect(
        run({ targets: [{ targetType: 'conditional', targetRef: 'x' }] }),
      ).rejects.toThrow();
    });

    /*
     * Proves `@ValidateNested` is wired to `@Type`. Without the transform the
     * members arrive as plain objects and the nested validators never run, so
     * this body would be accepted with a missing reference.
     */
    it('rejects a member missing its reference', async () => {
      await expect(run({ targets: [{ targetType: 'product' }] })).rejects.toThrow();
    });

    it('rejects an empty target list', async () => {
      await expect(run({ targets: [] })).rejects.toThrow();
    });
  });

  describe('the M13.6 shape, still accepted', () => {
    /*
     * The DTO's job is to *admit* this shape; the controller converts it. The
     * conversion itself is asserted in `assignments.controller.spec.ts`, which
     * is where the code that does it lives.
     */
    it('admits a body carrying only external product ids', async () => {
      const dto = await run({ externalProductIds: ['wc-1', 'wc-2'] });

      expect(dto.externalProductIds).toEqual(['wc-1', 'wc-2']);
    });

    /*
     * 🔴 The failure mode `forbidNonWhitelisted` would cause if the legacy
     * field were not declared: the request is rejected naming `targets`, a
     * field the caller never sent.
     */
    it('does not reject the legacy field as unknown', async () => {
      await expect(run({ externalProductIds: ['wc-1'] })).resolves.toBeDefined();
    });

    it('rejects a non-string member rather than coercing it', async () => {
      await expect(run({ externalProductIds: [42] })).rejects.toThrow();
    });

    it('rejects an empty legacy list', async () => {
      await expect(run({ externalProductIds: [] })).rejects.toThrow();
    });

    /*
     * When both shapes arrive, the explicit one wins: it can express targets
     * the legacy field cannot, so silently preferring the narrower one would
     * drop the category the caller asked for.
     */
    it('prefers targets when both are sent', async () => {
      const dto = await run({
        targets: [{ targetType: 'category', targetRef: 'summer' }],
        externalProductIds: ['wc-1'],
      });

      expect(dto.targets).toEqual([
        { targetType: AssignmentTargetType.CATEGORY, targetRef: 'summer' },
      ]);
    });
  });

  it('rejects a body carrying neither shape', async () => {
    await expect(run({})).rejects.toThrow();
  });
});
