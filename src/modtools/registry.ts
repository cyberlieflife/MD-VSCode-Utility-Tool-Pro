import { ModToolPack } from './api';

// 扩展自带的全部模组 pack。一个 pack 放在 packs/<id>/ 下并在这里登记，扩展里没有别处读这个列表：
// host.ts 是它唯一的读者。
export const modToolPacks: readonly ModToolPack[] = [];
