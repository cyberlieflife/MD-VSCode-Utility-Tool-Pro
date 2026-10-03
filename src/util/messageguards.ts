// 校验跨边界消息时的通用守卫：确认某个值可以当对象读取。跨边界消息的字段级检查留在各自
// 的处理函数里，这里只收放之四海皆准的那一条。

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
