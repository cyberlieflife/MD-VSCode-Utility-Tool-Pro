import './setup';
import * as assert from 'assert';
import { Renderer } from '../../../webviewsrc/worldmap/renderer';

// getFactoryResourceRowsLayout drives both the tooltip frame size and the factory/resource rows
// drawn under state labels; these tests lock its geometry so the frame can never disagree with
// the drawn content after a refactor.
describe('webview/worldmap/renderer factory/resource rows layout', () => {
    const rendererAny = Renderer as any;
    const realFactoryImages = rendererAny.factoryImages;
    const fakeImage = { naturalWidth: 24, naturalHeight: 20 };

    const buildState = (buildings: Record<string, number>, resources: Record<string, number> = {}) =>
        ({ buildings, resources }) as any;

    const layoutOf = (state: any) =>
        rendererAny.getFactoryResourceRowsLayout(state, rendererAny.ICON_ROW_SCALE, rendererAny.ICON_ROW_LABEL_WIDTH);

    before(() => {
        rendererAny.factoryImages = { civilian: fakeImage, military: fakeImage };
    });

    after(() => {
        rendererAny.factoryImages = realFactoryImages;
    });

    it('measures the factory row from both civilian and military icons', () => {
        const layout = layoutOf(buildState({ industrial_complex: 3, arms_factory: 2 }));
        // Two icon slots: each icon width plus one number-slot width.
        const expectedWidth = 2 * (24 * rendererAny.ICON_ROW_SCALE + rendererAny.ICON_ROW_LABEL_WIDTH);
        assert.strictEqual(layout.factories.width, expectedWidth);
        assert.strictEqual(layout.factories.height, 20 * rendererAny.ICON_ROW_SCALE);
    });

    it('measures a civilian-only factory row', () => {
        const layout = layoutOf(buildState({ industrial_complex: 3 }));
        assert.strictEqual(layout.factories.width, 24 * rendererAny.ICON_ROW_SCALE + rendererAny.ICON_ROW_LABEL_WIDTH);
        assert.strictEqual(layout.factories.height, 20 * rendererAny.ICON_ROW_SCALE);
    });

    it('measures a military-only factory row', () => {
        const layout = layoutOf(buildState({ arms_factory: 2 }));
        assert.strictEqual(layout.factories.width, 24 * rendererAny.ICON_ROW_SCALE + rendererAny.ICON_ROW_LABEL_WIDTH);
        assert.strictEqual(layout.factories.height, 20 * rendererAny.ICON_ROW_SCALE);
    });

    it('produces an empty factory row when the state has no factories', () => {
        const layout = layoutOf(buildState({ infrastructure: 3 }));
        assert.strictEqual(layout.factories.width, 0);
        assert.strictEqual(layout.factories.height, 0);
    });

    it('measures the resource row with one slot per resource', () => {
        const layout = layoutOf(buildState({}, { steel: 5, oil: 2 }));
        assert.strictEqual(layout.resources.width, 2 * (24 * rendererAny.ICON_ROW_SCALE + rendererAny.ICON_ROW_LABEL_WIDTH));
        assert.strictEqual(layout.resources.height, 24 * rendererAny.ICON_ROW_SCALE);
    });

    it('adds the row gap only when both rows exist', () => {
        const both = layoutOf(buildState({ industrial_complex: 1 }, { steel: 5 }));
        assert.strictEqual(both.gap, rendererAny.ICON_ROW_GAP);
        assert.strictEqual(both.totalHeight, both.factories.height + rendererAny.ICON_ROW_GAP + both.resources.height);

        const factoriesOnly = layoutOf(buildState({ industrial_complex: 1 }));
        assert.strictEqual(factoriesOnly.gap, 0);
        assert.strictEqual(factoriesOnly.totalHeight, factoriesOnly.factories.height);

        const resourcesOnly = layoutOf(buildState({}, { steel: 5 }));
        assert.strictEqual(resourcesOnly.gap, 0);
        assert.strictEqual(resourcesOnly.totalHeight, resourcesOnly.resources.height);

        const empty = layoutOf(buildState({}));
        assert.strictEqual(empty.totalHeight, 0);
        assert.strictEqual(empty.totalWidth, 0);
    });

    it('takes the wider row as the total width', () => {
        const layout = layoutOf(buildState({ industrial_complex: 1, arms_factory: 1 }, { steel: 5 }));
        assert.strictEqual(layout.totalWidth, Math.max(layout.factories.width, layout.resources.width));
    });

    it('falls back to placeholder sizes when the factory icons are not loaded yet', () => {
        rendererAny.factoryImages = {};
        const layout = layoutOf(buildState({ industrial_complex: 1 }));
        assert.strictEqual(layout.factories.width, 24 * rendererAny.ICON_ROW_SCALE + rendererAny.ICON_ROW_LABEL_WIDTH);
        assert.strictEqual(layout.factories.height, 24 * rendererAny.ICON_ROW_SCALE);
        rendererAny.factoryImages = { civilian: fakeImage, military: fakeImage };
    });
});
