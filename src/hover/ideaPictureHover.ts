import * as vscode from 'vscode';
import { Node, parseHoi4File, resolveScriptVariables, SymbolNode } from '../hoiformat/hoiparser';
import { getSpriteByGfxName, Sprite } from '../util/image/imagecache';
import { Hoi4FsSchema } from '../constants';
import { localize } from '../util/i18n';

// When the gfx index flag is on, getSpriteByGfxName resolves sprites through the index and
// ignores this path; with the flag off it scans the given gfx files instead, and the ideas
// sprite sheet is the container that virtually all GFX_idea_* sprites live in.
const IDEAS_GFX_FALLBACK = 'interface/ideas.gfx';

// Hover images taller than this are scaled down proportionally so a hi-res icon does not
// dwarf the hover window; anything smaller is shown at its native size.
const MAX_HOVER_IMAGE_HEIGHT = 128;

// The hover applies to real files (mod workspace) and to the read-only virtual filesystem
// mounted at the HOI4 install path; everything else (webviews, output, diff views of other
// schemes) is out of scope.
const hoverableSchemes = ['file', Hoi4FsSchema];

export function isIdeaFile(uri: vscode.Uri): boolean {
    if (!hoverableSchemes.includes(uri.scheme)) {
        return false;
    }
    // Segment match anywhere in the path so ideas files in nested folders also qualify,
    // case-insensitively and with both path separators.
    return /(^|[\\/])common[\\/]ideas[\\/]/i.test(uri.path);
}

export function findPictureNodeAtOffset(root: Node, offset: number): Node | undefined {
    // Plain DFS over the whole tree: inside common/ideas files a "picture" key only appears
    // inside idea blocks, so the category/idea nesting does not need to be modelled here.
    // The end offset counts as a hit too, keeping the hover alive when the caret sits right
    // after the last character of the value.
    const stack = Array.isArray(root.value) ? [...root.value] : [];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (
            node.name === 'picture' &&
            node.valueStartToken !== null && node.valueEndToken !== null &&
            offset >= node.valueStartToken.start && offset <= node.valueEndToken.end
        ) {
            return node;
        }
        if (Array.isArray(node.value)) {
            stack.push(...node.value);
        }
    }
    return undefined;
}

export function extractPictureName(node: Node): string | undefined {
    // A bare token parses into a SymbolNode and a quoted one into an already-unquoted
    // string (parseNodeValue strips the quotes); numbers can never reference a sprite.
    const value = node.value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (value !== null && typeof value === 'object' && 'name' in value) {
        const name = (value as SymbolNode).name;
        return name.length > 0 ? name : undefined;
    }
    return undefined;
}

export function buildGfxCandidates(pictureName: string): string[] {
    // Ideas reference their icon by bare name and the sprite is conventionally named
    // GFX_idea_<picture>; the bare GFX_<picture> spelling exists in the wild too. A value
    // that already carries the GFX_ prefix is used as-is.
    if (/^gfx_/i.test(pictureName)) {
        return [pictureName];
    }
    return ['GFX_idea_' + pictureName, 'GFX_' + pictureName];
}

// Plain-data payload so the content composition stays unit-testable without dragging
// vscode types into the assertions.
export interface HoverPictureContent {
    gfxName: string;
    dataUrl: string;
    displayWidth: number;
    displayHeight: number;
    sourceWidth: number;
    sourceHeight: number;
}

export function buildHoverPicture(sprite: Sprite): HoverPictureContent {
    // Multi-frame sprites are horizontal strips: frame 0 is what the game shows in the
    // idea list, and sprite.width already divides the strip width by the frame count.
    const frame = sprite.noOfFrames > 1 ? sprite.frames[0] : sprite.image;
    const scale = frame.height > MAX_HOVER_IMAGE_HEIGHT ? MAX_HOVER_IMAGE_HEIGHT / frame.height : 1;
    return {
        gfxName: sprite.id,
        dataUrl: frame.uri,
        displayWidth: Math.round(frame.width * scale),
        displayHeight: Math.round(frame.height * scale),
        sourceWidth: frame.width,
        sourceHeight: frame.height,
    };
}

export function buildHoverMissMessage(candidates: string[]): string {
    return localize('hover.ideapicture.notfound', 'Picture image not found: {0}', candidates.join(', '));
}

export async function resolveSprite(candidates: string[]): Promise<Sprite | undefined> {
    for (const candidate of candidates) {
        const sprite = await getSpriteByGfxName(candidate, IDEAS_GFX_FALLBACK);
        if (sprite) {
            return sprite;
        }
    }
    return undefined;
}

// Parsed trees are memoized per document version: a hover fires on every small mouse move,
// and reparsing a large ideas file each time would be wasteful. The WeakMap lets closed
// documents be garbage-collected along with their trees.
const parseCache = new WeakMap<vscode.TextDocument, { version: number; root: Node }>();

// Shared read-only fallback for documents that currently fail to parse.
const emptyRoot: Node = {
    name: null,
    nameToken: null,
    operator: null,
    operatorToken: null,
    value: [],
    valueStartToken: null,
    valueEndToken: null,
    valueAttachment: null,
    valueAttachmentToken: null,
};

function getParsedRoot(document: vscode.TextDocument): Node {
    const cached = parseCache.get(document);
    if (cached && cached.version === document.version) {
        return cached.root;
    }

    try {
        // resolveScriptVariables rewrites `@constant` references (a picture may legally be
        // one) in place; doing it here keeps the cached tree ready for direct lookup.
        const root = resolveScriptVariables(parseHoi4File(document.getText()));
        parseCache.set(document, { version: document.version, root });
        return root;
    } catch (e) {
        // A file being edited is unparseable all the time; hovering must stay silent
        // instead of surfacing parser errors on every keystroke. Cache the empty root for
        // this version too: the document stays unparseable until the next edit bumps the
        // version, so re-parsing (and re-throwing) on every hover event is wasted work.
        parseCache.set(document, { version: document.version, root: emptyRoot });
        return emptyRoot;
    }
}

export function registerIdeaPictureHover(): vscode.Disposable {
    return vscode.languages.registerHoverProvider('*', {
        async provideHover(document: vscode.TextDocument, position: vscode.Position) {
            if (!isIdeaFile(document.uri)) {
                return undefined;
            }

            const pictureNode = findPictureNodeAtOffset(getParsedRoot(document), document.offsetAt(position));
            if (!pictureNode) {
                return undefined;
            }

            const startToken = pictureNode.valueStartToken;
            const endToken = pictureNode.valueEndToken;
            const pictureName = extractPictureName(pictureNode);
            if (!startToken || !endToken || !pictureName) {
                return undefined;
            }

            const candidates = buildGfxCandidates(pictureName);
            const sprite = await resolveSprite(candidates);

            const markdown = new vscode.MarkdownString();
            markdown.supportHtml = true;
            if (sprite) {
                const picture = buildHoverPicture(sprite);
                markdown.appendMarkdown(`\`${picture.gfxName}\`\n\n`);
                markdown.appendMarkdown(`<img src="${picture.dataUrl}" width="${picture.displayWidth}" height="${picture.displayHeight}">\n\n`);
                markdown.appendMarkdown(`\`${picture.sourceWidth}\u00d7${picture.sourceHeight}\``);
            } else {
                markdown.appendMarkdown(buildHoverMissMessage(candidates));
            }

            // Anchor the hover to the value range so the popup stays put while the mouse
            // moves within the word.
            const range = new vscode.Range(document.positionAt(startToken.start), document.positionAt(endToken.end));
            return new vscode.Hover(markdown, range);
        }
    });
}
