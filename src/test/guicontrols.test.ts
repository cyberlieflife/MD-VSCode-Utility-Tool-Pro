import * as assert from 'assert';
import { GuiFile, guiFileSchema, ContainerWindowType } from '../hoiformat/gui';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { HOIPartial, convertNodeToJson } from '../hoiformat/schema';
import { Sprite } from '../util/image/sprite';
import { RenderContainerWindowOptions, renderContainerWindow, renderContainerWindowChildren } from '../util/hoi4gui/containerwindow';
import { StyleTable } from '../util/styletable';

// The generic controls (edit box, dropdown, the list/overlap boxes, both scrollbars) are what a
// complex window such as the political panel is built from. A control the schema does not know is
// dropped at parse time and the preview shows a hole where it should be, so these tests pin both
// the parse shape and the render dispatch.

function parseContainerWindow(content: string): HOIPartial<ContainerWindowType> {
    const gui = convertNodeToJson<GuiFile>(parseHoi4File(`guiTypes = { containerWindowType = { name = "root" ${content} } }`), guiFileSchema);
    return gui.guitypes[0].containerwindowtype[0];
}

function stubSprite(): Sprite {
    return {
        id: 'test',
        width: 10,
        height: 10,
        frames: [{ uri: 'data:image/png;base64,' }],
    } as unknown as Sprite;
}

describe('hoiformat/gui common controls', () => {
    it('parses the layout and input controls into their own arrays', () => {
        const container = parseContainerWindow(`
            editBoxType = { name = "name" borderSize = { x = 3 y = 2 } }
            listBoxType = { name = "list" }
            smoothListBoxType = { name = "smooth_list" }
            overlappingElementsBoxType = { name = "overlap" }
            dropDownBoxType = {
                name = "dropdown"
                editBoxType = { name = "dropdown_edit" }
                expandButton = { name = "expand" spriteType = "GFX_button" }
                expandedWindow = { name = "expanded" show_position = { x = 0 y = 25 } }
            }
            extendedScrollbarType = { name = "scrollbar" slider = { name = "slider" spriteType = "GFX_slider" } }
        `);

        assert.strictEqual(container.editboxtype.length, 1);
        assert.strictEqual(container.editboxtype[0].bordersize?.x?._value, 3);
        assert.strictEqual(container.editboxtype[0].bordersize?.y?._value, 2);
        assert.strictEqual(container.listboxtype.length, 1);
        assert.strictEqual(container.smoothlistboxtype.length, 1);
        assert.strictEqual(container.overlappingelementsboxtype.length, 1);
        assert.strictEqual(container.dropdownboxtype.length, 1);
        assert.strictEqual(container.extendedscrollbartype.length, 1);
        assert.strictEqual(container.extendedscrollbartype[0].slider?.name, 'slider');

        const dropdown = container.dropdownboxtype[0];
        assert.strictEqual(dropdown.editboxtype.length, 1);
        assert.strictEqual(dropdown.editboxtype[0].name, 'dropdown_edit');
        assert.strictEqual(dropdown.expandbutton?.name, 'expand');
        assert.strictEqual(dropdown.expandedwindow?.name, 'expanded');
        assert.strictEqual(dropdown.expandedwindow?.show_position?.y?._value, 25);
    });

    it('parses a top-level scrollbar and the parent link between its buttons', () => {
        const gui = convertNodeToJson<GuiFile>(parseHoi4File(`
            guiTypes = {
                scrollbarType = {
                    name = "top_level_scrollbar" horizontal = 1
                    slider = "slider" track = "track" leftButton = "left" rightButton = "right"
                    guiButtonType = { parent = "slider" name = "down" }
                }
                extendedScrollbarType = { name = "top_level_extended_scrollbar" }
            }
        `), guiFileSchema);
        const guiTypes = gui.guitypes[0];

        assert.strictEqual(guiTypes.scrollbartype.length, 1);
        const scrollbar = guiTypes.scrollbartype[0];
        assert.strictEqual(scrollbar.horizontal, 1);
        assert.strictEqual(scrollbar.guibuttontype[0].parent, 'slider');
        assert.deepStrictEqual(
            [scrollbar.slider, scrollbar.track, scrollbar.leftbutton, scrollbar.rightbutton],
            ['slider', 'track', 'left', 'right'],
        );
        assert.strictEqual(guiTypes.extendedscrollbartype.length, 1);
    });
});

describe('util/hoi4gui container window dispatch', () => {
    const parentInfo = { size: { width: 500, height: 400 }, orientation: 'upper_left' as const };

    it('dispatches every supported child type', async () => {
        const container = parseContainerWindow(`
            buttonType = { name = "button" }
            editBoxType = { name = "edit" }
            dropDownBoxType = { name = "dropdown" }
            overlappingElementsBoxType = { name = "overlap" }
            smoothListBoxType = { name = "smooth" }
            listBoxType = { name = "list" }
            scrollbarType = { name = "scrollbar" }
            extendedScrollbarType = { name = "extended" }
            iconType = { name = "icon" }
            instantTextBoxType = { name = "text" }
            gridBoxType = { name = "grid" }
            containerWindowType = { name = "container" }
        `);
        const onRenderChild: RenderContainerWindowOptions['onRenderChild'] = async (type, child) => `[${type}:${child.name}]`;

        const rendered = await renderContainerWindowChildren(container, parentInfo, {
            styleTable: new StyleTable(),
            onRenderChild,
        });

        assert.deepStrictEqual(rendered.match(/\[[^\]]+\]/g), [
            '[button:button]',
            '[editbox:edit]',
            '[dropdownbox:dropdown]',
            '[overlappingelementsbox:overlap]',
            '[smoothlistbox:smooth]',
            '[listbox:list]',
            '[scrollbar:scrollbar]',
            '[extendedscrollbar:extended]',
            '[icon:icon]',
            '[instanttextbox:text]',
            '[gridbox:grid]',
            '[containerwindow:container]',
        ]);
    });

    it('keeps the source order of a dropdown box, its expand button and its expanded window', async () => {
        const container = parseContainerWindow(`
            dropDownBoxType = {
                name = "dropdown"
                buttonType = { name = "first" }
                expandedWindow = { name = "expanded" }
                iconType = { name = "third" }
                expandButton = { name = "expand" }
                editBoxType = { name = "last" }
            }
        `);
        const onRenderChild: RenderContainerWindowOptions['onRenderChild'] = async (type, child) =>
            type === 'dropdownbox' ? undefined : `[${child.name}]`;

        const rendered = await renderContainerWindowChildren(container, parentInfo, {
            styleTable: new StyleTable(),
            onRenderChild,
        });

        assert.deepStrictEqual(rendered.match(/\[[^\]]+\]/g), [
            '[first]',
            '[expanded]',
            '[third]',
            '[expand]',
            '[last]',
        ]);
    });

    it('renders a dropdown with a hidden expanded window and an expand button class', async () => {
        const container = parseContainerWindow(`
            dropDownBoxType = {
                name = "dropdown" position = { x = 10 y = 40 } size = { x = 180 y = 30 }
                expandButton = { name = "expand" spriteType = "GFX_button" }
                expandedWindow = { name = "expanded" size = { x = 180 y = 100 } show_position = { x = 17 y = 29 } }
            }
        `);
        const rendered = await renderContainerWindow(container, parentInfo, {
            styleTable: new StyleTable(),
            getSprite: async () => stubSprite(),
        });

        assert.ok(rendered.includes('gui-dropdown'), 'the dropdown frame carries the gui-dropdown class');
        assert.ok(rendered.includes('gui-dropdown-button'), 'the expand button carries the gui-dropdown-button class');
        assert.ok(/gui-dropdown-expanded" hidden/.test(rendered), 'the expanded window starts hidden');
    });

    it('positions a scrollbar button relative to the parent it names and swaps axes when horizontal', async () => {
        const container = parseContainerWindow(`
            scrollbarType = {
                name = "scrollbar" position = { x = 0 y = 0 } size = { x = 16 y = 120 } horizontal = 1
                guiButtonType = { name = "slider" spriteType = "GFX_slider" position = { x = 12 y = 0 } }
                guiButtonType = { parent = "slider" name = "down" spriteType = "GFX_down" position = { x = 0 y = 30 } }
            }
        `);
        const styleTable = new StyleTable();
        await renderContainerWindow(container, parentInfo, {
            styleTable,
            getSprite: async () => stubSprite(),
        });
        const css = styleTable.toRawCss();

        // The child's own offset (0,30) is summed with its parent's (12,0); horizontal swaps the
        // axes, so the child ends up at left: 30, top: 12 rather than left: 12, top: 30.
        assert.ok(/\.button\s*\{[^}]*left:\s*30px/.test(css) || css.includes('left: 30px'), 'the child is offset by its parent, axis-swapped');
        assert.ok(css.includes('top: 12px'), 'the child keeps the parent-relative coordinate after the swap');
    });
});
