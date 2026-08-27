import { CustomMap, SchemaDef } from "../../../hoiformat/schema";
import { FileLoader, LoadResultOD, FolderLoader, mergeInLoadResult } from "./common";
import { MapLoaderExtra, Resource } from "../definitions";
import { readFileFromModOrHOI4AsJson } from "../../../util/fileloader";
import { LoadResult, LoaderSession } from '../../../util/loader/loader';
import { localize } from '../../../util/i18n';
import { getSpriteByGfxName } from "../../../util/image/imagecache";
import * as vscode from 'vscode';

interface ResourceFile {
    resources: CustomMap<ResourceDef>
}

interface ResourceDef {
    icon_frame: number;
}

const resourceFileSchema: SchemaDef<ResourceFile> = {
    resources: {
        _innerType: {
            icon_frame: "number",
        },
        _type: "map",
    },
};

const resourceGfxFile = 'interface/general_stuff.gfx';

export class ResourceDefinitionLoader extends FolderLoader<Resource[], Resource[]> {
    constructor() {
        super('common/resources', ResourceFileLoader);
    }
    
    protected mergeFiles(fileResults: LoadResult<Resource[], MapLoaderExtra>[], _session: LoaderSession): Promise<LoadResult<Resource[], MapLoaderExtra>> {
        const results =  mergeInLoadResult(fileResults, 'result');
        const resourceMap: Record<string, Resource> = {};
        const warnings = mergeInLoadResult(fileResults, 'warnings');

        for (const resource of results) {
            if (resource.name in resourceMap) {
                warnings.push({
                    source: [],
                    text: localize('worldmap.warnings.resourcedefinedtwice', 'Resource {0} is defined in two files: {1}, {2}.',
                        resource.name, resource.file, resourceMap[resource.name].file),
                    relatedFiles: [resource.file, resourceMap[resource.name].file],
                });
            } else {
                resourceMap[resource.name] = resource;
            }
        }

        return Promise.resolve({
            result: Object.values(resourceMap),
            warnings,
            dependencies: [this.folder + '/*'],
        });
    }

    public toString() {
        return `[ResourceDefinitionLoader]`;
    }
}

export class ResourceFileLoader extends FileLoader<Resource[]> {
    protected async loadFromFile(): Promise<LoadResultOD<Resource[]>> {
        return {
            result: await loadResources(this.file),
            warnings: [],
            dependencies: [resourceGfxFile],
        };
    }

    public toString() {
        return `[ResourceFileLoader ${this.file}]`;
    }
}

async function loadResources(file: string): Promise<Resource[]> {
    const data = await readFileFromModOrHOI4AsJson<ResourceFile>(file, resourceFileSchema);
    const image = await getSpriteByGfxName('GFX_resources_strip', resourceGfxFile);
    return Object.values(data.resources._map).map<Resource>(v => {
        const name = v._key;
        const iconFrame = v._value.icon_frame ?? 0;
        const imageUri = image?.frames[iconFrame - 1]?.uri ?? image?.frames[0]?.uri ?? '';
        return { name, displayName: localisedResourceName(name), iconFrame, imageUri, file };
    });
}

// The game draws resource names as icons, so its localisation files carry no per-resource keys.
// Display names for the vanilla resources come from this table (matching the extension's own
// localisation languages); modded resources keep their key as the display name.
const resourceNamesByLanguage: Record<string, Record<string, string>> = {
    'zh-cn': {
        oil: '石油',
        steel: '钢材',
        tungsten: '钨矿',
        chromium: '铬矿',
        aluminium: '铝土矿',
        rubber: '橡胶',
        coal: '煤炭',
    },
    ko: {
        oil: '석유',
        steel: '강철',
        tungsten: '텅스텐',
        chromium: '크롬',
        aluminium: '알루미늄',
        rubber: '고무',
        coal: '석탄',
    },
    ru: {
        oil: 'нефть',
        steel: 'сталь',
        tungsten: 'вольфрам',
        chromium: 'хром',
        aluminium: 'алюминий',
        rubber: 'каучук',
        coal: 'уголь',
    },
};

function localisedResourceName(name: string): string {
    const table = resourceNamesByLanguage[vscode.env.language.toLowerCase()];
    return table?.[name] ?? name;
}
