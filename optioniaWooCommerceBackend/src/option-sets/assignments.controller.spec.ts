import { AssignmentTargetType } from '../common/database/enums';
import { AssignmentsController } from './assignments.controller';
import type { AssignmentsService, AssignmentTarget } from './assignments.service';
import { AssignTargetsDto } from './dto/assign-product.dto';

/**
 * The controller's request normalisation (M19.1').
 *
 * 🔴 **Tested here because it could not live in the DTO.** `class-transformer`
 * fixes an instance's properties from the keys the source object carries, so a
 * per-property `@Transform` cannot create `targets` on a body that omits it.
 * The conversion moved here, so its coverage did too.
 */
describe('AssignmentsController', () => {
  /** What reached the service on the last call. */
  let seen: { id: string; targets: AssignmentTarget[] } | undefined;

  const service = {
    assign: jest.fn(async (id: string, targets: AssignmentTarget[]) => {
      seen = { id, targets };
      return { assignments: [], configVersion: 1 };
    }),
    unassign: jest.fn(async () => ({ assignments: [], configVersion: 1 })),
  } as unknown as AssignmentsService;

  const controller = new AssignmentsController(service);

  const body = (fields: Partial<AssignTargetsDto>): AssignTargetsDto =>
    Object.assign(new AssignTargetsDto(), fields);

  beforeEach(() => {
    seen = undefined;
    jest.clearAllMocks();
  });

  describe('assign', () => {
    it('passes explicit targets through unchanged', async () => {
      await controller.assign('set-1', body({
        targets: [
          { targetType: AssignmentTargetType.CATEGORY, targetRef: 'summer' },
          { targetType: AssignmentTargetType.TAG, targetRef: 'sale' },
        ],
      }));

      expect(seen?.targets).toEqual([
        { targetType: 'category', targetRef: 'summer' },
        { targetType: 'tag', targetRef: 'sale' },
      ]);
    });

    it('reads the legacy shape as product targets', async () => {
      await controller.assign('set-1', body({ externalProductIds: ['wc-1', 'wc-2'] }));

      expect(seen?.targets).toEqual([
        { targetType: AssignmentTargetType.PRODUCT, targetRef: 'wc-1' },
        { targetType: AssignmentTargetType.PRODUCT, targetRef: 'wc-2' },
      ]);
    });

    /*
     * The explicit shape can express targets the legacy field cannot, so
     * preferring the narrower one would drop the category the caller asked for.
     */
    it('prefers explicit targets when both shapes are sent', async () => {
      await controller.assign('set-1', body({
        targets: [{ targetType: AssignmentTargetType.CATEGORY, targetRef: 'summer' }],
        externalProductIds: ['wc-1'],
      }));

      expect(seen?.targets).toEqual([
        { targetType: AssignmentTargetType.CATEGORY, targetRef: 'summer' },
      ]);
    });
  });

  describe('unassign', () => {
    /*
     * 🔴 Every URL written before M19.1' omits the query parameter and means a
     * product. Defaulting to anything else would silently retarget them.
     */
    it('defaults a missing target type to product', async () => {
      await controller.unassign('set-1', 'wc-1', undefined);

      expect(service.unassign).toHaveBeenCalledWith('set-1', {
        targetType: AssignmentTargetType.PRODUCT,
        targetRef: 'wc-1',
      });
    });

    it('treats an empty target type as absent', async () => {
      await controller.unassign('set-1', 'wc-1', '');

      expect(service.unassign).toHaveBeenCalledWith('set-1', {
        targetType: AssignmentTargetType.PRODUCT,
        targetRef: 'wc-1',
      });
    });

    it('honours an explicit target type', async () => {
      await controller.unassign('set-1', 'summer', 'category');

      expect(service.unassign).toHaveBeenCalledWith('set-1', {
        targetType: AssignmentTargetType.CATEGORY,
        targetRef: 'summer',
      });
    });

    /*
     * ⚠️ Coercing an unknown type to `product` would delete the wrong row
     * whenever a category and a product share a reference — and `targetRef` is
     * unique only within a type, so that collision is ordinary.
     */
    it('rejects an unknown target type rather than falling back', async () => {
      await expect(controller.unassign('set-1', 'wc-1', 'nonsense')).rejects.toThrow();
      expect(service.unassign).not.toHaveBeenCalled();
    });

    /*
     * ⚠️ `conditional` is an `AssignmentMode`, not a target type — see the note
     * in `assign-product.dto.spec.ts`. This covers the mode/target-type
     * confusion, not a gap between the enum and the authoring list.
     */
    it('rejects an assignment mode used as a target type', async () => {
      await expect(controller.unassign('set-1', 'wc-1', 'conditional')).rejects.toThrow();
      expect(service.unassign).not.toHaveBeenCalled();
    });
  });
});
