import * as assert from 'assert';
import { isOptionalBytes, isOptionalOffset, isOptionalString, isOffset, isRecord } from '../util/messageguards';

// 跨边界消息的通用守卫：值只有过了守卫才算数，处理器不读没检查过的东西。

describe('util/messageguards', () => {
    it('isRecord accepts any non-null object and nothing else', () => {
        assert.ok(isRecord({}));
        assert.ok(isRecord({ command: 'navigate' }));
        assert.ok(!isRecord(null));
        assert.ok(!isRecord(undefined));
        assert.ok(!isRecord('x'));
        assert.ok(!isRecord(7));
    });

    it('isOffset accepts non-negative integers only', () => {
        assert.ok(isOffset(0));
        assert.ok(isOffset(42));
        assert.ok(!isOffset(-1));
        assert.ok(!isOffset(1.5));
        assert.ok(!isOffset(NaN));
        assert.ok(!isOffset('3'));
        assert.ok(!isOffset(undefined));
    });

    it('isOptionalOffset and isOptionalString let the value be absent', () => {
        assert.ok(isOptionalOffset(undefined));
        assert.ok(isOptionalOffset(3));
        assert.ok(!isOptionalOffset(-3));

        assert.ok(isOptionalString(undefined));
        assert.ok(isOptionalString('a.txt'));
        assert.ok(!isOptionalString(7));
    });

    it('isOptionalBytes accepts the buffer shapes a webview can clone across', () => {
        assert.ok(isOptionalBytes(undefined));
        assert.ok(isOptionalBytes(new Uint8Array([1, 2, 3])));
        assert.ok(isOptionalBytes(new ArrayBuffer(4)));
        assert.ok(!isOptionalBytes('base64'));
        assert.ok(!isOptionalBytes([1, 2, 3]));
    });
});
