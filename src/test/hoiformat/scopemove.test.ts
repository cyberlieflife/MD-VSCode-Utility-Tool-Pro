import * as assert from 'assert';
import { parseHoi4File, Node } from '../../hoiformat/hoiparser';
import { Scope, countryScope, scopeDefs, tryMoveScope } from '../../hoiformat/scope';

// `tryMoveScope` decides which script names open a new scope. The table is what a condition or
// effect extraction walks, so a name the game added and the table misses silently drops the scope
// move and the extracted tree loses the branch below it.

function child(node: Node, name: string): Node {
    const found = (node.value as Node[]).find(n => n.name === name);
    assert.ok(found, `expected a child named ${name}`);
    return found!;
}

function move(nodeName: string, type: 'condition' | 'effect' = 'condition', from: Scope = countryScope): { moved: boolean; top: Scope } {
    const root = parseHoi4File(`${nodeName} = { inner = 1 }`);
    const stack: Scope[] = [from];
    const moved = tryMoveScope(child(root, nodeName), stack, type);
    return { moved, top: stack[stack.length - 1] };
}

describe('hoiformat/scope', () => {
    describe('scopeDefs table', () => {
        it('recognises the scopes added since HOI4 1.15', () => {
            const expected: [string, string][] = [
                ['any_state_in', 'state'],
                ['all_scientists', 'character'],
                ['any_scientist', 'character'],
                ['every_scientist', 'character'],
                ['random_scientist', 'character'],
                ['all_active_scientist', 'character'],
                ['any_active_scientist', 'character'],
                ['every_active_scientist', 'character'],
                ['random_active_scientist', 'character'],
                ['all_country_of', 'country'],
                ['any_country_of', 'country'],
                ['any_state_of', 'state'],
                ['every_allied_country', 'country'],
                ['random_allied_country', 'country'],
                ['party_leader', 'character'],
                ['every_faction_member', 'country'],
                ['every_collection_element', 'unknown'],
            ];
            for (const [name, to] of expected) {
                assert.ok(scopeDefs[name], `scopeDefs is missing ${name}`);
                assert.strictEqual(scopeDefs[name].to, to, `${name} should target ${to}`);
            }
        });

        it('keeps the renamed purchase contract scopes and drops the military prefix', () => {
            for (const name of ['all_purchase_contract', 'any_purchase_contract', 'every_purchase_contract', 'random_purchase_contract']) {
                assert.ok(scopeDefs[name], `scopeDefs is missing ${name}`);
                assert.strictEqual(scopeDefs[name].to, 'purchaseContract');
            }
            assert.strictEqual(scopeDefs['all_military_purchase_contract'], undefined);
        });

        it('lets owner and controller be read as conditions too', () => {
            assert.strictEqual(scopeDefs['owner'].condition, true);
            assert.strictEqual(scopeDefs['owner'].effect, true);
            assert.strictEqual(scopeDefs['controller'].condition, true);
            assert.strictEqual(scopeDefs['controller'].effect, true);
        });

        it('adds the other-country variants', () => {
            assert.strictEqual(scopeDefs['all_other_country'].condition, true);
            assert.strictEqual(scopeDefs['random_other_country'].effect, true);
        });
    });

    describe('special project scope', () => {
        it('opens a specialProject scope for an sp: name', () => {
            const { moved, top } = move('sp:my_project');
            assert.strictEqual(moved, true);
            assert.strictEqual(top.scopeType, 'specialProject');
            assert.strictEqual(top.scopeName, 'my_project');
        });

        it('still opens a mio scope for an mio: name', () => {
            const { moved, top } = move('mio:my_org');
            assert.strictEqual(moved, true);
            assert.strictEqual(top.scopeType, 'mio');
            assert.strictEqual(top.scopeName, 'my_org');
        });
    });

    describe('new scope defs move the stack', () => {
        it('moves a country to a scientist character scope', () => {
            const { moved, top } = move('every_scientist', 'effect');
            assert.strictEqual(moved, true);
            assert.strictEqual(top.scopeType, 'character');
        });

        it('moves a country to an allied-country scope', () => {
            const { moved, top } = move('every_allied_country', 'effect');
            assert.strictEqual(moved, true);
            assert.strictEqual(top.scopeType, 'country');
        });

        it('moves to a state scope from any scope via any_state_in', () => {
            const { moved, top } = move('any_state_in', 'condition', { scopeName: 'x', scopeType: 'character' });
            assert.strictEqual(moved, true);
            assert.strictEqual(top.scopeType, 'state');
        });
    });
});
