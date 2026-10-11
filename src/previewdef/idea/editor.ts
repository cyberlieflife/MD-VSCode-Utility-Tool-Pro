import { Node, parseHoi4File } from "../../hoiformat/hoiparser";

// 一处文本替换：在文档的 [start, end) 写入 text；start === end 表示纯插入。
export interface IdeaTextEdit {
	start: number;
	end: number;
	text: string;
}

// 一条要写进 modifier 块的键值对，值按原样写回，保持文件里的字面量风格。
export interface IdeaModifierValue {
	key: string;
	value: string;
}

// 一个理念块及其所在分类、所在 ideas 根，编辑定位的返回值。
interface IdeaLocation {
	ideasRoot: Node;
	category: Node;
	idea: Node;
}

function blockChildren(node: Node): Node[] {
	return Array.isArray(node.value) ? node.value : [];
}

// 顶层可以有多个 `ideas = { }`，其下每个分类块、每个分类下每个理念块都收集起来。
function findIdea(root: Node, id: string): IdeaLocation | undefined {
	for (const ideasRoot of blockChildren(root)) {
		if (ideasRoot.name !== "ideas") {
			continue;
		}
		for (const category of blockChildren(ideasRoot)) {
			for (const idea of blockChildren(category)) {
				if (idea.name === id) {
					return { ideasRoot, category, idea };
				}
			}
		}
	}
	return undefined;
}

// 文档里优先使用的换行符。
function eolOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

// 一级缩进：取第一处缩进行的空白，识别不出时退回制表符。
function indentUnitOf(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const match = /^([ \t]+)\S/.exec(line);
		if (match) {
			return match[1];
		}
	}
	return "\t";
}

function lineIndentAt(text: string, pos: number): string {
	const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
	const match = /^[ \t]*/.exec(text.slice(lineStart, pos));
	return match ? match[0] : "";
}

// 理念块内字段的缩进：跟随块内已有字段行，块里还没有字段时按理念行缩进加一级。
function fieldIndentOf(text: string, idea: Node): string {
	const children = blockChildren(idea);
	const first = children[0];
	if (first?.nameToken) {
		return lineIndentAt(text, first.nameToken.start);
	}
	return lineIndentAt(text, idea.nameToken?.start ?? 0) + indentUnitOf(text);
}

// 向一个块里追加内容的落点：多行块落在 `{` 后第一行行首；空块 `{}` 没有可保留的内容，
// 直接用“替换整个花括号”的形式重写，避开放进单行块里缩进对不上。
function appendIntoBlock(
	text: string,
	node: Node,
	body: string,
	closingIndent: string,
): IdeaTextEdit | undefined {
	const anchorStart = node.valueStartToken?.start;
	const closeToken = node.valueEndToken;
	if (anchorStart === undefined || !closeToken) {
		return undefined;
	}
	const open = text.indexOf("{", anchorStart);
	if (open === -1 || closeToken.start < open) {
		return undefined;
	}
	const eol = eolOf(text);
	if (text.slice(open + 1, closeToken.start).trim() === "") {
		return { start: open, end: closeToken.end, text: `{${eol}${body}${closingIndent}}` };
	}
	const newline = text.indexOf("\n", open);
	if (newline === -1 || newline > closeToken.start) {
		return undefined;
	}
	return { start: newline + 1, end: newline + 1, text: body };
}

// 节点占用的整行范围（用于删除一个块），行首还有其它内容时只删节点本身。
function wholeLineRange(text: string, start: number, end: number): { start: number; end: number } {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	if (text.slice(lineStart, start).trim() !== "") {
		return { start, end };
	}
	const lineEnd = text.indexOf("\n", end);
	return { start: lineStart, end: lineEnd === -1 ? text.length : lineEnd + 1 };
}

function buildModifierLines(
	pairs: IdeaModifierValue[],
	entryIndent: string,
	eol: string,
): string {
	return pairs.map((pair) => `${entryIndent}${pair.key} = ${pair.value}`).join(eol);
}

// 一个完整理念块的文本，每行都带缩进、末尾带换行；缩进基准是理念块自身所在层级。
function buildIdeaBlock(
	id: string,
	idea: { picture?: string; modifiers: IdeaModifierValue[] },
	ideaIndent: string,
	unit: string,
	eol: string,
): string {
	const fieldIndent = ideaIndent + unit;
	const lines: string[] = [`${ideaIndent}${id} = {`];
	if (idea.picture) {
		lines.push(`${fieldIndent}picture = ${idea.picture}`);
	}
	if (idea.modifiers.length > 0) {
		lines.push(`${fieldIndent}modifier = {`);
		lines.push(buildModifierLines(idea.modifiers, fieldIndent + unit, eol));
		lines.push(`${fieldIndent}}`);
	}
	lines.push(`${ideaIndent}}`);
	return lines.join(eol) + eol;
}

/**
 * 把理念的 picture 改成给定值。`picture` 传文件里要写的字面量（裸名或带前缀的名字），
 * 已有 picture 行只替换值，缺失时在块首插入一行。
 */
export function buildIdeaPictureEdits(
	text: string,
	ideaId: string,
	picture: string,
): IdeaTextEdit[] {
	const root = parseHoi4File(text, "");
	const location = findIdea(root, ideaId);
	if (!location) {
		return [];
	}

	const existing = blockChildren(location.idea).find((child) => child.name === "picture");
	if (existing?.valueStartToken && existing.valueEndToken) {
		return [{ start: existing.valueStartToken.start, end: existing.valueEndToken.end, text: picture }];
	}

	const fieldIndent = fieldIndentOf(text, location.idea);
	const ideaIndent = lineIndentAt(text, location.idea.nameToken?.start ?? 0);
	const edit = appendIntoBlock(
		text,
		location.idea,
		`${fieldIndent}picture = ${picture}${eolOf(text)}`,
		ideaIndent,
	);
	return edit ? [edit] : [];
}

/**
 * 把理念的 modifier 块重写成给定的键值列表。列表为空时删除整个 modifier 块，理念本来没有
 * modifier 块而列表非空时新建一个。
 */
export function buildIdeaModifierEdits(
	text: string,
	ideaId: string,
	pairs: IdeaModifierValue[],
): IdeaTextEdit[] {
	const root = parseHoi4File(text, "");
	const location = findIdea(root, ideaId);
	if (!location) {
		return [];
	}

	const existing = blockChildren(location.idea).find(
		(child) => child.name === "modifier" && Array.isArray(child.value),
	);
	const eol = eolOf(text);

	if (!existing) {
		if (pairs.length === 0) {
			return [];
		}
		const fieldIndent = fieldIndentOf(text, location.idea);
		const body = `${fieldIndent}modifier = {${eol}` +
			`${buildModifierLines(pairs, fieldIndent + indentUnitOf(text), eol)}${eol}${fieldIndent}}${eol}`;
		const ideaIndent = lineIndentAt(text, location.idea.nameToken?.start ?? 0);
		const edit = appendIntoBlock(text, location.idea, body, ideaIndent);
		return edit ? [edit] : [];
	}

	if (pairs.length === 0) {
		const anchor = existing.nameToken?.start ?? existing.valueStartToken?.start;
		if (anchor === undefined || !existing.valueEndToken) {
			return [];
		}
		const range = wholeLineRange(text, anchor, existing.valueEndToken.end);
		return [{ start: range.start, end: range.end, text: "" }];
	}

	if (!existing.valueStartToken || !existing.valueEndToken) {
		return [];
	}
	const fieldIndent = lineIndentAt(text, existing.nameToken?.start ?? existing.valueStartToken.start);
	const body = buildModifierLines(pairs, fieldIndent + indentUnitOf(text), eol);
	return [{
		start: existing.valueStartToken.end,
		end: existing.valueEndToken.start,
		text: `${eol}${body}${eol}${fieldIndent}`,
	}];
}

/**
 * 新建一个理念。分类已存在时挂到该分类下，分类不存在时新建分类；连 `ideas = { }` 都没有时
 * 在文件末尾建一个。同名理念已存在时不做任何改动。
 */
export function buildCreateIdeaEdits(
	text: string,
	category: string,
	id: string,
	idea: { picture?: string; modifiers: IdeaModifierValue[] },
): IdeaTextEdit[] {
	const root = parseHoi4File(text, "");
	if (findIdea(root, id)) {
		return [];
	}

	const eol = eolOf(text);
	const unit = indentUnitOf(text);

	for (const ideasRoot of blockChildren(root)) {
		if (ideasRoot.name !== "ideas") {
			continue;
		}
		const categoryNode = blockChildren(ideasRoot).find((child) => child.name === category);
		if (categoryNode) {
			const categoryIndent = lineIndentAt(
				text,
				categoryNode.nameToken?.start ?? categoryNode.valueStartToken?.start ?? 0,
			);
			const body = buildIdeaBlock(id, idea, categoryIndent + unit, unit, eol);
			const edit = appendIntoBlock(text, categoryNode, body, categoryIndent);
			return edit ? [edit] : [];
		}
	}

	const existingRoot = blockChildren(root).find((child) => child.name === "ideas");
	if (existingRoot) {
		const rootIndent = lineIndentAt(
			text,
			existingRoot.nameToken?.start ?? existingRoot.valueStartToken?.start ?? 0,
		);
		const categoryIndent = rootIndent + unit;
		const body = `${categoryIndent}${category} = {${eol}` +
			`${buildIdeaBlock(id, idea, categoryIndent + unit, unit, eol)}${categoryIndent}}${eol}`;
		const edit = appendIntoBlock(text, existingRoot, body, rootIndent);
		return edit ? [edit] : [];
	}

	const body = `ideas = {${eol}${unit}${category} = {${eol}` +
		`${buildIdeaBlock(id, idea, unit + unit, unit, eol)}${unit}}${eol}}${eol}`;
	const prefix = text.length === 0 || text.endsWith(eol) ? "" : eol;
	return [{ start: text.length, end: text.length, text: prefix + body }];
}
