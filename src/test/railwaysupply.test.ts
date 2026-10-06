import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fileloader from '../util/fileloader';
import { LoaderSession } from '../util/loader/loader';
import { RailwayLoader, SupplyNodeLoader } from '../previewdef/worldmap/loader/railway';

// The railway and supply-node files are plain whitespace-separated rows. A row may be indented with
// spaces or tabs, and the parser must drop that leading whitespace before splitting: `parseInt("")`
// is NaN, so a leading empty field would shift every column and read the wrong province and level.

function stubMapLoader() {
    return {
        shouldReload: async () => false,
        load: async () => ({ result: { provinces: [undefined, { id: 1, edges: [] }] } }),
    } as any;
}

describe('previewdef/worldmap/loader railway and supply nodes', () => {
    const originalReadFile = (fileloader as any).readFileFromModOrHOI4;
    const originalExpiry = (fileloader as any).hoiFileExpiryToken;

    afterEach(() => {
        (fileloader as any).readFileFromModOrHOI4 = originalReadFile;
        (fileloader as any).hoiFileExpiryToken = originalExpiry;
    });

    function stubFiles(contents: Record<string, string>): void {
        (fileloader as any).hoiFileExpiryToken = async () => 'stable';
        (fileloader as any).readFileFromModOrHOI4 = async (file: string) => [
            Buffer.from(contents[file] ?? ''),
            vscode.Uri.file(file),
        ];
    }

    it('reads supply nodes whose rows start with spaces or tabs', async () => {
        stubFiles({ 'map/supply_nodes.txt': ' \t3 1\r\n\n\t2 1\r' });
        const loader = new SupplyNodeLoader(stubMapLoader());
        const result = await loader.load(new LoaderSession(false));
        assert.deepStrictEqual(result.result.supplyNodes, [
            { level: 3, province: 1 },
            { level: 2, province: 1 },
        ]);
        assert.deepStrictEqual(result.warnings, []);
    });

    it('reads railways whose rows start with spaces or tabs', async () => {
        stubFiles({ 'map/railways.txt': ' \t3 1 1\r\n\n\t2 1 1\r' });
        const loader = new RailwayLoader(stubMapLoader());
        const result = await loader.load(new LoaderSession(false));
        assert.deepStrictEqual(result.result.railways, [
            { level: 3, provinces: [1] },
            { level: 2, provinces: [1] },
        ]);
        assert.deepStrictEqual(result.warnings, []);
    });

    it('drops blank rows instead of reading them as NaN', async () => {
        stubFiles({ 'map/supply_nodes.txt': '3 1\n\n   \n2 1\n' });
        const loader = new SupplyNodeLoader(stubMapLoader());
        const result = await loader.load(new LoaderSession(false));
        assert.deepStrictEqual(result.result.supplyNodes, [
            { level: 3, province: 1 },
            { level: 2, province: 1 },
        ]);
    });
});
