import * as assert from 'assert';
import { focusLayerStyles } from '../previewdef/focustree/contentbuilder';
import { standardFocusTreeLayout } from '../previewdef/focustree/layout';

// 焦点图层 CSS 的两条契约：图标层是焦点的拖动命中区，必须保持可命中（网页端按命中的元素区分
// 拖动与框选）；各层位置随布局设置移动。
describe('previewdef/focustree layer styles', () => {
    it('keeps the icon layer hittable', () => {
        const styles = focusLayerStyles(standardFocusTreeLayout.item);
        assert.ok(!styles.iconLayer.includes('pointer-events'));
        assert.ok(!styles.iconLayer.includes('inset'));
        assert.ok(styles.iconLayer.includes('left: 50%'));
        assert.ok(styles.iconLayer.includes('top: calc(50% - 18px)'));
    });

    it('places the standard layout as it always has', () => {
        const styles = focusLayerStyles(standardFocusTreeLayout.item);
        assert.ok(styles.titlebarLayer.includes('top: 70px'));
        assert.ok(styles.overlayLayer.includes('translate(-50%, calc(-50% - 3px))'));
        assert.ok(styles.span.includes('margin-top: 85px'));
    });

    it('moves every layer by the item offsets of a gui layout', () => {
        const styles = focusLayerStyles({
            iconOffsetX: 5,
            iconOffsetY: -8,
            titlebarOffsetX: 6,
            titlebarTop: 75,
            overlayOffsetX: 5,
            overlayOffsetY: -5,
            textOffsetX: 4,
            textTop: 77,
        });
        assert.ok(styles.iconLayer.includes('left: calc(50% + 5px)'));
        assert.ok(styles.iconLayer.includes('top: calc(50% - 8px)'));
        assert.ok(styles.titlebarLayer.includes('left: calc(50% + 6px)'));
        assert.ok(styles.titlebarLayer.includes('top: 75px'));
        assert.ok(styles.overlayLayer.includes('translate(calc(-50% + 5px), calc(-50% - 5px))'));
        assert.ok(styles.span.includes('margin-top: 77px'));
        assert.ok(styles.span.includes('left: 4px'));
    });
});
