// 校验跨边界消息时的通用守卫：确认某个值可以当对象读取。跨边界消息的字段级检查留在各自
// 的处理函数里，这里只收放之四海皆准的那一条。

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** A document offset: a non-negative integer. */
export function isOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isOptionalOffset(value: unknown): value is number | undefined {
	return value === undefined || isOffset(value);
}

export function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

/**
 * Raw bytes posted by a webview. VS Code structured-clones ArrayBuffers and typed arrays across
 * the boundary, so an image comes over as bytes rather than as a base64 data URI.
 */
export function isOptionalBytes(
	value: unknown,
): value is Uint8Array | ArrayBuffer | undefined {
	return (
		value === undefined ||
		value instanceof Uint8Array ||
		value instanceof ArrayBuffer
	);
}
