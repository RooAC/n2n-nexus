/**
 * CLI Argument Parsing
 */

const args = process.argv.slice(2);

export function getArg(k: string): string {
    const i = args.indexOf(k);
    return i !== -1 && args[i + 1] ? args[i + 1] : "";
}
