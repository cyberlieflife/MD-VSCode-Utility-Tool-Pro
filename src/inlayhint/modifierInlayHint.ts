import * as vscode from 'vscode';
import { Hoi4FsSchema } from '../constants';
import { Node, parseHoi4File, SymbolNode } from '../hoiformat/hoiparser';
import { ensureLocalisationIndex, getLocalisedTextUnchecked } from '../util/localisationIndex';
import { getConfiguration } from '../util/vsccommon';

// A hint collected from a document: the text offset it is anchored to and what it displays.
export interface ModifierHint {
    offset: number;
    text: string;
}

interface CachedHints {
    document: vscode.TextDocument;
    version: number;
    hints: ModifierHint[];
}

const modifierScriptSchemes = ['file', Hoi4FsSchema];

// Modifier names in scripts are lower-case symbols (army_attack_factor). Requiring that shape keeps
// unrelated upper-cased tokens out of the localisation lookup.
const modifierNameRegex = /^[a-z][a-z0-9_]*$/;

// MODIFIER_* localisation keys that hold UI strings instead of a modifier name: without this,
// a `none` symbol would display "没有" and `base_value` would display "基础值".
const excludedModifierNames = new Set([
    'none',
    'base_value',
    'base_value_percentage',
    'base_value_str',
    'not_supported',
    'scaled_by',
]);
const excludedModifierNameSuffixes = /_(desc|prefix|format)$/;

// Hints longer than this are cut off: an inline hint must never push the line content away.
const MAX_INLAY_TEXT_LENGTH = 80;

// Hints are cached per document so switching between files does not re-parse them. The map is used
// as an LRU cache: past the limit the least recently requested document is evicted.
const HINT_CACHE_LIMIT = 64;
const hintCache = new Map<string, CachedHints>();

export function isModifierScriptFile(uri: vscode.Uri): boolean {
    return modifierScriptSchemes.includes(uri.scheme) && /\.txt$/i.test(uri.path);
}

/**
 * Returns the localisation keys to try for a modifier name, most specific first. Vanilla localisation
 * is inconsistent about the key shape, so an upper-cased MODIFIERS_/MODIFIER_ prefix and the
 * lower-case `modifier_` prefix are all tried; `MODIFIERS_` wins because the game tooltips reference
 * that form when both exist for the same name. The `<name>_tt` tooltip key is tried last: several
 * modifiers (monthly_population, experience_gain_army_factor) have no key of their own and are only
 * mapped through it.
 */
export function buildModifierLocalisationKeys(name: string): string[] {
    const upperName = name.toUpperCase();
    const excluded = excludedModifierNames.has(name.toLowerCase()) || excludedModifierNameSuffixes.test(name);
    const keys: string[] = [`MODIFIERS_${upperName}`];
    if (!excluded) {
        keys.push(`MODIFIER_${upperName}`);
    }
    keys.push(`modifier_${name}`);
    if (!excluded) {
        keys.push(`${name}_tt`);
    }
    return keys;
}

/**
 * Turns a raw localisation value into a single-line hint: `$MODIFIER_XXX$`-style placeholders are
 * replaced by the referenced name when it is known, the remaining placeholders (formatting
 * directives like `$RIGHT|+=%1$`) and icon tokens are removed, and colour codes and line breaks are
 * dropped so the result fits on one line.
 */
export function formatInlayText(raw: string, lookup: (key: string) => string | undefined): string {
    const text = raw
        .replace(/\\n/g, ' ')
        // Placeholders are resolved before the colour codes are stripped: a replacement is itself a
        // localisation value and may carry `§Y...§!` sequences that must not reach the hint.
        .replace(/\$([^$\n]*)\$/g, (_match, key: string) => {
            return /^(MODIFIERS?_|modifier_)/.test(key) ? lookup(key) ?? '' : '';
        })
        .replace(/§[\s\S]/g, '')
        // `£prod_eff_cap`-style tokens render as icons in game; inline they are just noise.
        .replace(/£[A-Za-z0-9_]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > MAX_INLAY_TEXT_LENGTH ? text.substring(0, MAX_INLAY_TEXT_LENGTH) + '…' : text;
}

/**
 * Resolves a `$...$` reference inside a localisation value. Vanilla tooltips reference modifier
 * names without a consistent prefix (`$communism_drift$`, `$CARRIER_SORTIE_EFFICIENCY_FACTOR$`), so
 * a bare identifier is retried with the same MODIFIERS_/MODIFIER_/modifier_ key shapes used for
 * modifier names. Formatting directives such as `$RIGHT|+=%1$` fail the identifier test and stay
 * unresolved.
 */
function resolveLocalisationReference(key: string, lookup: (key: string) => string | undefined): string | undefined {
    const direct = lookup(key);
    if (direct !== undefined) {
        return direct;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        return undefined;
    }
    const upper = key.toUpperCase();
    return lookup(`MODIFIERS_${upper}`) ?? lookup(`MODIFIER_${upper}`) ?? lookup(`modifier_${key.toLowerCase()}`);
}

/**
 * `<name>_tt` keys are shared by modifiers, triggers, effects and AI weights; only modifier tooltips
 * bind the value through a placeholder such as `$RIGHT|+=%1$`. Tooltips without one describe
 * something other than a modifier (transfer_state_tt, is_literally_china_tt), so they must not
 * produce a hint.
 */
function hasValueBinding(raw: string): boolean {
    return /\$[^$\n]*\|[^$\n]*\$/.test(raw);
}

/**
 * A `<name>_tt` tooltip of a modifier opens with the modifier itself, as a reference either followed
 * by a colon or by the bound value directly. A tooltip that starts with a sentence instead belongs to
 * something else and only mentions a key along the way: `tier_two_threshold_tt` names
 * `$tier_one_threshold$`, the neighbouring tax bracket, in the middle of its sentence.
 */
function tooltipNameReference(raw: string): string | undefined {
    const match = raw.match(/^\W*\$([^$\n]+)\$/u);
    return match?.[1];
}

/**
 * Stripping the placeholders out of a tooltip that carries no name of its own leaves the punctuation
 * that introduced them behind: "Damage taken: $RIGHT|+=%1$" would read as "Damage taken:".
 */
function trimDanglingPunctuation(text: string): string {
    return text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}

/**
 * `<name>_tt` tooltip values wrap the modifier name in a placeholder reference, e.g.
 * `" $MODIFIER_GLOBAL_MONTHLY_POPULATION$: $RIGHT|+=%1$"`. Returns the text of that reference so the
 * hint shows the bare name; when it does not resolve the caller falls back to the tooltip itself.
 */
function extractTooltipName(raw: string, lookup: (key: string) => string | undefined): string | undefined {
    const reference = tooltipNameReference(raw);
    if (reference === undefined) {
        return undefined;
    }
    const text = resolveLocalisationReference(reference, lookup);
    if (text === undefined) {
        return undefined;
    }
    const formatted = formatInlayText(text, lookup);
    return formatted === '' ? undefined : formatted;
}

/**
 * Returns the text to show for a modifier name, or undefined when no candidate key resolves. A
 * `<name>_tt` tooltip value is used only when it binds a value: the referenced name is then shown
 * instead of the whole tooltip. Any other key is formatted as a plain value.
 */
function resolveModifierHintText(name: string, lookup: (key: string) => string | undefined): string | undefined {
    for (const key of buildModifierLocalisationKeys(name)) {
        const text = lookup(key);
        if (text === undefined) {
            continue;
        }
        if (key !== `${name}_tt`) {
            return formatInlayText(text, lookup);
        }
        if (!hasValueBinding(text)) {
            return undefined;
        }
        // A tooltip whose reference does not resolve leaves only its plain text behind.
        return extractTooltipName(text, lookup) ?? trimDanglingPunctuation(formatInlayText(text, lookup));
    }
    return undefined;
}

function getNodeValueText(node: Node): string | undefined {
    if (typeof node.value === 'string') {
        return node.value;
    }
    if (node.value !== null && !Array.isArray(node.value) && typeof node.value === 'object') {
        return (node.value as SymbolNode).name;
    }
    return undefined;
}

/**
 * Walks every node of the parsed script (blocks at any depth) and collects a hint for each node name
 * that resolves to a localised modifier name, plus one for the localisation key behind a
 * `custom_modifier_tooltip` value.
 */
export function collectModifierHints(root: Node, lookup: (key: string) => string | undefined): ModifierHint[] {
    const hints: ModifierHint[] = [];
    const stack: Node[] = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.name !== null && node.nameToken !== null && modifierNameRegex.test(node.name)) {
            const text = resolveModifierHintText(node.name, lookup);
            if (text !== undefined && text !== '') {
                hints.push({ offset: node.nameToken.end, text });
            }
        }
        if (node.name === 'custom_modifier_tooltip' && node.nameToken !== null) {
            const key = getNodeValueText(node);
            if (key !== undefined) {
                const text = lookup(key);
                if (text !== undefined) {
                    const formatted = formatInlayText(text, lookup);
                    if (formatted !== '') {
                        hints.push({
                            offset: node.valueEndToken?.end ?? node.nameToken.end,
                            text: formatted,
                        });
                    }
                }
            }
        }
        if (Array.isArray(node.value)) {
            for (const child of node.value) {
                stack.push(child);
            }
        }
    }
    hints.sort((a, b) => a.offset - b.offset);
    return hints;
}

function buildHintsForDocument(document: vscode.TextDocument): ModifierHint[] {
    const language = vscode.env.language;
    const lookup = (key: string): string | undefined => {
        // getLocalisedTextUnchecked falls back to the key itself when nothing was found.
        const text = getLocalisedTextUnchecked(key, language);
        return text === key ? undefined : text;
    };
    try {
        return collectModifierHints(parseHoi4File(document.getText()), lookup);
    } catch {
        // A script that is being edited can be temporarily unparsable: show no hint for it instead of an error.
        return [];
    }
}

export function registerModifierInlayHint(): vscode.Disposable {
    return vscode.languages.registerInlayHintsProvider(
        modifierScriptSchemes.map((scheme) => ({ scheme })),
        {
            async provideInlayHints(document, range, token) {
                if (!getConfiguration().get<boolean>('modifierInlayHint', true)) {
                    return [];
                }
                if (!isModifierScriptFile(document.uri)) {
                    return [];
                }

                const cacheKey = document.uri.toString();
                let cached = hintCache.get(cacheKey);
                if (cached === undefined || cached.document !== document || cached.version !== document.version) {
                    try {
                        await ensureLocalisationIndex();
                    } catch {
                        // Without the localisation index no name can be resolved; show nothing.
                        return [];
                    }
                    if (token.isCancellationRequested) {
                        return [];
                    }
                    cached = { document, version: document.version, hints: buildHintsForDocument(document) };
                }

                // Touch the entry so the LRU eviction drops the least recently requested document.
                hintCache.delete(cacheKey);
                hintCache.set(cacheKey, cached);
                if (hintCache.size > HINT_CACHE_LIMIT) {
                    const oldestKey = hintCache.keys().next().value;
                    if (oldestKey !== undefined) {
                        hintCache.delete(oldestKey);
                    }
                }

                const startOffset = document.offsetAt(range.start);
                const endOffset = document.offsetAt(range.end);
                return cached.hints
                    .filter((hint) => hint.offset >= startOffset && hint.offset <= endOffset)
                    .map((hint) => {
                        const inlayHint = new vscode.InlayHint(document.positionAt(hint.offset), hint.text, vscode.InlayHintKind.Type);
                        inlayHint.paddingLeft = true;
                        return inlayHint;
                    });
            },
        }
    );
}
