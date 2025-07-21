import fsp from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { txEnv, txHostConfig } from "@core/globalData";
import { redactStartupSecrets } from "@lib/misc";
import path from "path";


/**
 * Blackhole event logger
 */
let lastBlackHoleSpewTime = 0;
const blackHoleSpillMaxInterval = 5000;
export const childProcessEventBlackHole = (...args: any[]) => {
    const currentTime = Date.now();
    if (currentTime - lastBlackHoleSpewTime > blackHoleSpillMaxInterval) {
        //Let's call this "hawking radiation"
        console.verbose.error('ChildProcess unexpected event:');
        console.verbose.dir(args);
        lastBlackHoleSpewTime = currentTime;
    }
};


/**
 * Returns a tuple with the convar name and value, formatted for the server command line
 */
export const getMutableConvars = (isCmdLine = false) => {
    const checkPlayerJoin = txConfig.banlist.enabled || txConfig.whitelist.mode !== 'disabled';
    const convars: RawConvarSetTuple[] = [
        ['setr', 'locale', txConfig.general.language ?? 'en'],
        ['set', 'serverName', txConfig.general.serverName ?? 'txAdmin'],
        ['set', 'checkPlayerJoin', checkPlayerJoin],
        ['set', 'menuAlignRight', txConfig.gameFeatures.menuAlignRight],
        ['set', 'menuPageKey', txConfig.gameFeatures.menuPageKey],
        ['set', 'playerModePtfx', txConfig.gameFeatures.playerModePtfx],
        ['set', 'hideAdminInPunishments', txConfig.gameFeatures.hideAdminInPunishments],
        ['set', 'hideAdminInMessages', txConfig.gameFeatures.hideAdminInMessages],
        ['set', 'hideDefaultAnnouncement', txConfig.gameFeatures.hideDefaultAnnouncement],
        ['set', 'hideDefaultDirectMessage', txConfig.gameFeatures.hideDefaultDirectMessage],
        ['set', 'hideDefaultWarning', txConfig.gameFeatures.hideDefaultWarning],
        ['set', 'hideDefaultScheduledRestartWarning', txConfig.gameFeatures.hideDefaultScheduledRestartWarning],

        // //NOTE: no auto update, maybe we shouldn't tie core and server verbosity anyways
        // ['setr', 'verbose', console.isVerbose],
    ];
    return convars.map((c) => polishConvarSetTuple(c, isCmdLine));
};

type RawConvarSetTuple = [setter: string, name: string, value: any];
type ConvarSetTuple = [setter: string, name: string, value: string];

const polishConvarSetTuple = ([setter, name, value]: RawConvarSetTuple, isCmdLine = false): ConvarSetTuple => {
    return [
        isCmdLine ? `+${setter}` : setter,
        'txAdmin-' + name,
        value.toString(),
    ];
}

export const mutableConvarConfigDependencies = [
    'general.*',
    'gameFeatures.*',
    'banlist.enabled',
    'whitelist.mode',
];


/**
 * Pre calculating HOST dependent spawn variables
 */
const txCoreEndpoint = txHostConfig.netInterface
    ? `${txHostConfig.netInterface}:${txHostConfig.txaPort}`
    : `127.0.0.1:${txHostConfig.txaPort}`;
let osSpawnVars: OsSpawnVars;
if (txEnv.isWindows) {
    osSpawnVars = {
        bin: `${txEnv.fxsPath}/FXServer.exe`,
        args: [],
    };
} else {
    const alpinePath = path.resolve(txEnv.fxsPath, '../../');
    osSpawnVars = {
        bin: `${alpinePath}/opt/cfx-server/ld-musl-x86_64.so.1`,
        args: [
            '--library-path', `${alpinePath}/usr/lib/v8/:${alpinePath}/lib/:${alpinePath}/usr/lib/`,
            '--',
            `${alpinePath}/opt/cfx-server/FXServer`,
            '+set', 'citizen_dir', `${alpinePath}/opt/cfx-server/citizen/`,
        ],
    };
}

type OsSpawnVars = {
    bin: string;
    args: string[];
}


/**
 * Returns the variables needed to spawn the server
 */
export const getFxSpawnVariables = (): FxSpawnVariables => {
    if (!txConfig.server.dataPath) throw new Error('Missing server data path');

    const hathoraArgs = [];
    if (txHostConfig.hathora.enabled) {
        hathoraArgs.push(
            // These convars are needed for running on Hathora
            '+set', 'sv_forceIndirectListing', 'true',
            '+set', 'sv_listingHostOverride', `${txHostConfig.hathora.hostname}:${txHostConfig.hathora.port}`,
            '+set', 'sv_proxyIPRanges', `${txHostConfig.hathora.ip}/32`,
            '+set', 'sv_endpoints', `${txHostConfig.hathora.ip}:${txHostConfig.hathora.port}`,
        );
    }

    const cmdArgs = [
        ...osSpawnVars.args,
        getMutableConvars(true), //those are the ones that can change without restart
        txConfig.server.startupArgs,
        '+set', 'onesync', txConfig.server.onesync,
        '+sets', 'txAdmin-version', txEnv.txaVersion,
        '+setr', 'txAdmin-menuEnabled', txConfig.gameFeatures.menuEnabled,
        '+set', 'txAdmin-luaComHost', txCoreEndpoint,
        '+set', 'txAdmin-luaComToken', txCore.webServer.luaComToken,
        '+set', 'txAdminServerMode', 'true', //Can't change this one due to fxserver code compatibility
        '+exec', txConfig.server.cfgPath,
        ...hathoraArgs,
    ].flat(2).map(String);

    return {
        bin: osSpawnVars.bin,
        args: cmdArgs,
        serverName: txConfig.general.serverName,
        dataPath: txConfig.server.dataPath,
        cfgPath: txConfig.server.cfgPath,
    }
}

type FxSpawnVariables = OsSpawnVars & {
    dataPath: string;
    cfgPath: string;
    serverName: string;
}


/**
 * Print debug information about the spawn variables
 */
export const debugPrintSpawnVars = (fxSpawnVars: FxSpawnVariables) => {
    if (!console.verbose) return; //can't console.verbose.table

    console.debug('Spawn Bin:', fxSpawnVars.bin);
    const args = redactStartupSecrets(fxSpawnVars.args)
    console.debug('Spawn Args:');
    const argsTable = [];
    let currArgs: string[] | undefined;
    for (const arg of args) {
        if (arg.startsWith('+')) {
            if (currArgs) argsTable.push(currArgs);
            currArgs = [arg];
        } else {
            if (!currArgs) currArgs = [];
            currArgs.push(arg);
        }
    }
    if (currArgs) argsTable.push(currArgs);
    console.table(argsTable);
}


/**
 * Type guard for a valid child process
 */
export const isValidChildProcess = (p: any): p is ValidChildProcess => {
    if (!p) return false;
    if (typeof p.pid !== 'number') return false;
    if (!Array.isArray(p.stdio)) return false;
    if (p.stdio.length < 4) return false;
    if (!(p.stdio[3] instanceof Readable)) return false;
    return true;
};
export type ValidChildProcess = ChildProcessWithoutNullStreams & {
    pid: number;
    readonly stdio: [
        Writable,
        Readable,
        Readable,
        Readable,
        Readable | Writable | null | undefined, // extra
    ];
};


/**
 * Sanitizes an argument for console input.
 */
export const sanitizeConsoleArgString = (arg: string) => {
    if (typeof arg !== 'string') throw new Error('unexpected type');
    return arg.replaceAll(/(?<!\\)"/g, '\"')
        .replaceAll(/;/g, '\u037e')
        .replaceAll(/\n/g, ' ');
}


/**
 * Stringifies the command arguments for console output.  
 * Arguments are wrapped in double quotes.
 * Double quotes are replaced by unicode equivalent.
 * Objects are JSON.stringified.  
 *   
 * NOTE: We expect the other side to know they have to parse non-string arguments.  
 *   
 * NOTE: Escaping double quotes is working, but escaping semicolon is bugged
 * and doesn't happen when there is an odd number of escaped double quotes in the argument.
 */
export const stringifyConsoleArgs = (args: (string | number | object)[]) => {
    const cleanArgs: string[] = [];
    for (const arg of args) {
        if (typeof arg === 'string') {
            cleanArgs.push(sanitizeConsoleArgString(JSON.stringify(arg)));
        } else if (typeof arg === 'number') {
            cleanArgs.push(sanitizeConsoleArgString(JSON.stringify(arg.toString())));
        } else if (typeof arg === 'object' && arg !== null) {
            const json = JSON.stringify(arg);
            const escaped = json.replaceAll(/"/g, '\\"');
            cleanArgs.push(`"${sanitizeConsoleArgString(escaped)}"`);
        } else {
            throw new Error('arg expected to be string or object');
        }
    }

    return cleanArgs.join(' ');
}


/**
 * Copies the custom locale file from txData to the 'monitor' path, due to sandboxing.
 * FIXME: move to core/lib/fxserver/runtimeFiles.ts
 */
export const setupCustomLocaleFile = async () => {
    if (txConfig.general.language !== 'custom') return;
    const srcPath = txCore.translator.customLocalePath;
    const destRuntimePath = path.resolve(txEnv.txaPath, '.runtime');
    const destFilePath = path.resolve(destRuntimePath, 'locale.json');
    try {
        await fsp.mkdir(destRuntimePath, { recursive: true });
        await fsp.copyFile(srcPath, destFilePath);
    } catch (error) {
        console.tag('FXRunner').error(`Failed to copy custom locale file: ${(error as any).message}`);
    }
}
