import * as assert from 'assert';
import * as path from 'path';
import { UserError } from '../util/common';
import {
    decodeImageToPng,
    _resetImageWorkerPathForTest,
    _setImageWorkerPathForTest,
    _terminateImageWorkerForTest,
} from '../util/image/imagedecoder';
// 只为让 tsc 产出 worker 入口；该模块只在真正作为 worker 运行时挂监听。
import '../util/image/imageworker';

// 同步解码与 worker 解码共用 DDS 解析；替换静态方法即可统计主线程解码次数。
const ddsModule = require('../util/image/dds') as typeof import('../util/image/dds');

// 头长度合法但魔数错误：worker 侧 DDS.parse 抛 UserError，属于坏输入。
function invalidMagicDds(): Buffer {
    return Buffer.alloc(128);
}

describe('util/image/imagedecoder bad input', () => {
    let syncAttempts = 0;
    const realParse = ddsModule.DDS.parse;
    let originalConsoleError: typeof console.error;

    before(() => {
        _setImageWorkerPathForTest(path.resolve(__dirname, '../util/image/imageworker.js'));
        // 回退路径会通过 error() 记录 worker 失败；这里只需要断言次数。
        originalConsoleError = console.error;
        console.error = () => undefined;
    });

    beforeEach(() => {
        syncAttempts = 0;
        ddsModule.DDS.parse = (...args) => {
            syncAttempts++;
            return realParse(...args);
        };
    });

    afterEach(() => {
        ddsModule.DDS.parse = realParse;
    });

    after(async () => {
        await _terminateImageWorkerForTest();
        _resetImageWorkerPathForTest();
        console.error = originalConsoleError;
    });

    it('does not retry a bad input decode on the extension host', async () => {
        await assert.rejects(
            decodeImageToPng(invalidMagicDds(), 'dds'),
            (e: unknown) => e instanceof UserError,
        );
        assert.strictEqual(syncAttempts, 0, 'bad input must not be decoded synchronously as well');
    });

    it('still falls back to the extension host when the worker fails for another reason', async () => {
        // 8 字节的缓冲区在 worker 侧是 RangeError，不属于坏输入分类。
        await assert.rejects(decodeImageToPng(Buffer.alloc(8), 'dds'));
        assert.strictEqual(syncAttempts, 1, 'a worker failure must still retry synchronously');
    });
});
