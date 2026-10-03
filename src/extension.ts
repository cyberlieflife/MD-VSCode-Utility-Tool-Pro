import * as vscode from 'vscode';
import { previewManager } from './previewdef/previewmanager';
import { registerContextContainer, setVscodeContext } from './context';
import { DDSViewProvider, TGAViewProvider } from './ddsviewprovider';
import { registerModFile } from './util/modfile';
import { worldMap } from './previewdef/worldmap';
import { ViewType, ContextName } from './constants';
import { registerTelemetryReporter, sendEvent } from './util/telemetry';
import { registerScanReferencesCommand } from './util/dependency';
import { registerHoiFs } from './util/hoifs';
import { loadI18n } from './util/i18n';
import { registerGfxIndex } from './util/gfxindex';
import { Logger } from "./util/logger";
import { registerLocalisationIndex } from "./util/localisationIndex";
import { registerSharedFocusIndex } from "./util/sharedFocusIndex";
import { registerFeatureFlags } from "./util/featureflags";
import { registerIdeaPictureHover } from "./hover/ideaPictureHover";
import { registerIdeaSwapIndex } from "./util/ideaSwapIndex";
import { registerModifierInlayHint } from "./inlayhint/modifierInlayHint";
import { registerAuditFocusTreesCommand } from "./previewdef/focustree/warningreport";

export function activate(context: vscode.ExtensionContext) {
    let locale = (context as any).extension?.packageJSON.locale;
    if (locale === "%hoi4modutilities.locale%") {
        locale = 'en';
    }

    Logger.initialize();

    loadI18n(locale);

    // Must register this first because other component may use it.
    context.subscriptions.push(registerContextContainer(context));
    context.subscriptions.push(registerTelemetryReporter());
    context.subscriptions.push(registerFeatureFlags());

    sendEvent('extension.activate', { locale, isWeb: IS_WEB_EXT.toString() });

    // A line the reader can find in the HOI4 Modding output channel to tell which build is
    // actually running, since every fix ships as an in-place VSIX reinstall.
    Logger.info(`HOI4 Utilities Pro ${VERSION} activated (locale: ${locale}).`);

    context.subscriptions.push(previewManager.register());
    context.subscriptions.push(registerModFile());
    context.subscriptions.push(worldMap.register());
    context.subscriptions.push(registerScanReferencesCommand());
    context.subscriptions.push(registerAuditFocusTreesCommand());
    context.subscriptions.push(registerHoiFs());
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(ViewType.DDS, new DDSViewProvider()));
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(ViewType.TGA, new TGAViewProvider()));
    context.subscriptions.push(registerSharedFocusIndex());
    context.subscriptions.push(registerGfxIndex());
    context.subscriptions.push(registerLocalisationIndex());
    context.subscriptions.push(registerIdeaPictureHover());
    context.subscriptions.push(registerIdeaSwapIndex());
    context.subscriptions.push(registerModifierInlayHint());

    setVscodeContext(ContextName.Hoi4MULoaded, true);
}

export function deactivate() {}
