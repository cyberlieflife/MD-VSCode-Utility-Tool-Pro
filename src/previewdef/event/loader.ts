import { HOIEvents, HOIEvent, getEvents } from "./schema";
import { ContentLoader, Dependency, LoadResultOD, LoaderSession, mergeInLoadResult } from "../../util/loader/loader";
import { parseHoi4File } from "../../hoiformat/hoiparser";
import { localize } from "../../util/i18n";
import { chain, uniq, flatten, uniqBy } from "lodash";
import { YamlLoader } from "../../util/loader/yaml";
import { getGfxContainerFiles } from "../../util/gfxindex";
import { getLanguageIdInYml } from "../../util/vsccommon";
import { ensureEventIndex, findFileByEventId } from "../../util/eventIndex";
import { eventTreePreview } from "../../util/featureflags";

export interface EventsLoaderResult {
    events: HOIEvents;
    mainNamespaces: string[];
    gfxFiles: string[];
    localizationDict: Record<string, string>;
}

const eventsGFX = 'interface/eventpictures.gfx';

export class EventsLoader extends ContentLoader<EventsLoaderResult> {
    private languageKey: string = '';

    public async shouldReloadImpl(session: LoaderSession): Promise<boolean> {
        return await super.shouldReloadImpl(session) || this.languageKey !== getLanguageIdInYml();
    }

    protected async postLoad(content: string | undefined, dependencies: Dependency[], error: any, session: LoaderSession): Promise<LoadResultOD<EventsLoaderResult>> {
        if (error || (content === undefined)) {
            throw error;
        }

        this.languageKey = getLanguageIdInYml();

        const eventsDependencies = dependencies.filter(d => d.type === 'event').map(d => d.path);

        const events = getEvents(parseHoi4File(content, localize('infile', 'In file {0}:\n', this.file)), this.file);
        // 选项里引用的子事件可能定义在别的文件，没有 `#!event:` 注释时靠索引补上依赖，
        // 否则它们只会画成 unresolved 占位。
        const childEventFiles = await this.findChildEventFiles(events);
        for (const childEventFile of childEventFiles) {
            if (!eventsDependencies.includes(childEventFile) && childEventFile !== this.file) {
                eventsDependencies.push(childEventFile);
            }
        }

        const eventsDepFiles = await this.loaderDependencies.loadMultiple(eventsDependencies, session, EventsLoader);
        const mergedEvents = mergeEvents(events, ...eventsDepFiles.map(f => f.result.events));
        
        const localizationDependencies = dependencies.filter(d => d.type.match(/^locali[sz]ation$/) && d.path.endsWith('.yml')).map(d => d.path);
        const localizationDepFiles = await this.loaderDependencies.loadMultiple(localizationDependencies, session, YamlLoader);

        const localizationDict = makeLocalizationDict(mergeInLoadResult(localizationDepFiles, 'result'), this.languageKey);
        Object.assign(localizationDict, ...eventsDepFiles.map(f => f.result.localizationDict));
        
        const gfxDependencies = [
            ...dependencies.filter(d => d.type === 'gfx').map(d => d.path),
            ...flatten(eventsDepFiles.map(f => f.result.gfxFiles)),
            ...await getGfxContainerFiles(flatten(Object.values(events.eventItemsByNamespace)).map(e => e.picture)),
        ];

        return {
            result: {
                events: mergedEvents,
                mainNamespaces: Object.keys(events.eventItemsByNamespace),
                gfxFiles: uniq([...gfxDependencies, eventsGFX]),
                localizationDict,
            },
            dependencies: uniq([
                this.file,
                ...eventsDependencies,
                ...mergeInLoadResult(eventsDepFiles, 'dependencies'),
                ...localizationDependencies,
                ...flatten(eventsDepFiles.map(f => f.dependencies)),
            ])
        };
    }

    public toString() {
        return `[EventsLoader ${this.file}]`;
    }

    /**
     * Resolves the files that define this file's child events through the event index. Skipped when
     * the index switch is off or the index isn't built yet: the preview then shows the ids it has,
     * instead of waiting for a build that may never run.
     */
    private async findChildEventFiles(events: HOIEvents): Promise<string[]> {
        if (!eventTreePreview) {
            return [];
        }

        await ensureEventIndex();

        return chain(Object.values(events.eventItemsByNamespace))
            .flatMap(e => e)
            .flatMap(e => [...e.immediate.childEvents, ...flatten(e.options.map(o => o.childEvents))])
            .map(ce => findFileByEventId(ce.eventName))
            .uniq()
            .filter((e): e is string => e !== undefined)
            .value();
    }
}

function mergeEvents(...events: HOIEvents[]): HOIEvents {
    // 同名命名空间按文件顺序拼接而不是整体覆盖：依赖文件与主文件都声明同一命名空间时，
    // 覆盖会让主文件的事件整批消失。同一 id 出现两次由下游的 id 映射按后加载者覆盖。
    const eventItemsByNamespace: Record<string, HOIEvent[]> = {};
    for (const e of events) {
        for (const [namespace, items] of Object.entries(e.eventItemsByNamespace)) {
            eventItemsByNamespace[namespace] = [...(eventItemsByNamespace[namespace] ?? []), ...items];
        }
    }

    return {
        eventItemsByNamespace,
        conditionExprs: uniqBy(
            flatten(events.map(e => e.conditionExprs)),
            e => e.scopeName + '@' + e.nodeContent,
        ),
    };
}

function makeLocalizationDict(dicts: any[], language: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const dict of dicts) {
        if (dict[language] && typeof dict[language] === 'object' && !Array.isArray(dict[language])) {
            Object.assign(result, dict[language]);
        }
    }

    return result;
}
