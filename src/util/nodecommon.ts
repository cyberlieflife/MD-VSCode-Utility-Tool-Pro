import * as path from 'path';

export function matchPathEnd(pathname: string, segments: string[]): boolean {
    pathname = pathname.replace(/\/|\\/g, path.sep);

    for (let i = segments.length - 1; i >= 0; i--) {
        const name = path.basename(pathname);
        pathname = path.dirname(pathname);

        if (segments[i] === '*') {
            continue;
        }

        if (segments[i].toLowerCase() !== name.toLowerCase()) {
            return false;
        }
    }

    return true;
}

// The key two spellings of one folder share: slashes normalized, case folded on Windows only,
// because /mods/Parent and /mods/parent are distinct folders elsewhere.
export function pathIdentity(value: string): string {
    const normalized = value.replace(/\\+/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isSamePath(a: string, b: string): boolean {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
