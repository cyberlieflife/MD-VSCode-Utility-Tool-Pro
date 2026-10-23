import * as assert from "assert";
import { loadEntrypoint } from "./setup";
import { TraitCard } from "../../previewdef/character/payload";

// 特质卡的 pill 是 button：Enter/Space 到达时既要展开详情，也不能让共享导航把焦点文件打开。

// `typeof import(...)` 让 tsc 把入口模块编进本测试的 outDir；纯 require 不会。
const { module: characterPreview } = loadEntrypoint(
    () => require("../../../webviewsrc/characterpreview") as typeof import("../../../webviewsrc/characterpreview"),
);

function traitWithDetail(): TraitCard {
    return {
        id: "test_trait",
        name: { key: "test_trait", text: "Test Trait" },
        desc: { key: "test_trait_desc", text: "A trait with a description." },
        known: true,
        icon: undefined,
        traitType: undefined,
        modifiers: [],
        groups: [],
        hasDetail: true,
        nav: undefined,
    };
}

function keydown(el: HTMLElement, key: string, code: string, init: KeyboardEventInit = {}): void {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, code, bubbles: true, ...init }));
}

describe("webview/characterpreview trait keyboard", () => {
    it("expands and collapses the detail with Enter", () => {
        const box = characterPreview.traitToDom(traitWithDetail());
        const pill = box.querySelector("button") as HTMLButtonElement;
        const detail = box.querySelector(".char-trait-mods") as HTMLElement;
        assert.ok(pill, "the pill should be a button");
        assert.ok(detail, "the detail block should exist");
        assert.strictEqual(detail.hidden, true);

        keydown(pill, "Enter", "Enter");
        assert.strictEqual(detail.hidden, false);
        assert.strictEqual(pill.getAttribute("aria-expanded"), "true");

        keydown(pill, "Enter", "Enter");
        assert.strictEqual(detail.hidden, true);
        assert.strictEqual(pill.getAttribute("aria-expanded"), "false");
    });

    it("toggles with Space as well", () => {
        const box = characterPreview.traitToDom(traitWithDetail());
        const pill = box.querySelector("button") as HTMLButtonElement;
        const detail = box.querySelector(".char-trait-mods") as HTMLElement;

        keydown(pill, " ", "Space");
        assert.strictEqual(detail.hidden, false);
    });

    it("leaves the key to the shared navigator when ctrl or meta is held", () => {
        const box = characterPreview.traitToDom(traitWithDetail());
        const pill = box.querySelector("button") as HTMLButtonElement;
        const detail = box.querySelector(".char-trait-mods") as HTMLElement;

        keydown(pill, "Enter", "Enter", { ctrlKey: true });
        assert.strictEqual(detail.hidden, true);

        keydown(pill, "Enter", "Enter", { metaKey: true });
        assert.strictEqual(detail.hidden, true);
    });

    it("ignores auto-repeat so a held key does not flicker the detail", () => {
        const box = characterPreview.traitToDom(traitWithDetail());
        const pill = box.querySelector("button") as HTMLButtonElement;
        const detail = box.querySelector(".char-trait-mods") as HTMLElement;

        keydown(pill, "Enter", "Enter", { repeat: true });
        assert.strictEqual(detail.hidden, true);
    });
});
