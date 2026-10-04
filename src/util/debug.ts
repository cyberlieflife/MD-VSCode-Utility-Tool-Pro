import { sendException } from "./telemetry";
import { forceError, UserError } from "./common";
import { Logger } from "./logger";

// The unit tests set MD_UTILITIES_TEST (in their vscode stub), so a passing run is not buried
// under every debug line the code under test prints.
export function debug(message: any, ...args: any[]): void {
    if (process.env.NODE_ENV !== 'production' && !process.env.MD_UTILITIES_TEST) {
        console.log(message, ...args);
    }
}

/**
 * Renders a parse or load failure for a log line: an Error's stack, or its message when the stack
 * is empty, and any other thrown value as text.
 */
export function describeParseFailure(cause: unknown): string {
    if (cause instanceof Error) {
        return cause.stack || cause.message;
    }

    try {
        return String(cause);
    } catch {
        return Object.prototype.toString.call(cause);
    }
}

export function error(error: unknown): void {
    console.error(error);
    let realError = forceError(error);
    Logger.error(typeof error === 'string' ? error : (realError.stack ?? realError.message));

    // Duck-type YAMLException by name so this module doesn't statically import js-yaml (which would
    // pull the library in at activation just for logging). js-yaml sets `name` to 'YAMLException'.
    const isYamlException = (error as { name?: string } | null)?.name === 'YAMLException';
    if (!(error instanceof UserError) && !isYamlException) {
        sendException(realError, { callerStack: new Error().stack ?? '' });
    }
}
