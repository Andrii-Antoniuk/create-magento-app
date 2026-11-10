const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * Commands that change a project's containers or data. Before one runs, an
 * external guard (for example a slot pool that shares one Docker stack between
 * several checkouts) can refuse it, and is told when it ends.
 */
const GATED_COMMANDS = ['start', 'stop', 'import-db', 'cleanup']

const defaultConfigFile = () => {
    const { projectsConfig } = require('../config/config')
    return path.join(path.dirname(projectsConfig.path), 'lifecycle-guard.json')
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, configFile?: string }} [options]
 * @returns {{ file: string, command: string[] } | null}
 */
const readGuard = ({ env = process.env, configFile } = {}) => {
    const file = env.CMA_LIFECYCLE_GUARD || configFile || defaultConfigFile()
    let raw
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
        if (e.code === 'ENOENT' && !env.CMA_LIFECYCLE_GUARD) {
            return null
        }
        throw new Error(`Cannot read lifecycle guard ${file}: ${e.message}`)
    }
    let config
    try {
        config = JSON.parse(raw)
    } catch (e) {
        throw new Error(`Lifecycle guard ${file} is not valid JSON: ${e.message}`)
    }
    if (
        !Array.isArray(config.command) ||
        config.command.length === 0 ||
        !config.command.every((part) => typeof part === 'string')
    ) {
        throw new Error(
            `Lifecycle guard ${file} has no "command" array of strings`
        )
    }
    return { file, command: config.command }
}

/**
 * Asks the guard to admit `command` for the project in `cwd`. Exits the
 * process when the guard refuses or cannot run (fail closed), and registers
 * the matching `end` call on exit when it admits.
 *
 * An interrupted command (SIGINT, SIGTERM, SIGHUP) does not call `end`: the
 * Docker work it already started can still be running or finishing in the
 * engine. It calls `interrupt` instead, which keeps the guard closed until
 * someone reconciles, and then dies of the same signal as it would have.
 *
 * @param {string} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, configFile?: string, exit?: (code: number) => void, onExit?: (fn: () => void) => void, onSignal?: (signal: string, fn: () => void) => void }} [options]
 * @returns {{ status: 'not-gated' | 'no-guard' | 'admitted', file?: string }}
 */
const enterLifecycleGuard = (
    command,
    {
        cwd = process.cwd(),
        env = process.env,
        configFile,
        exit = (code) => process.exit(code),
        onExit = (fn) => process.once('exit', fn),
        onSignal = defaultOnSignal
    } = {}
) => {
    if (!GATED_COMMANDS.includes(command)) {
        return { status: 'not-gated' }
    }
    let guard
    try {
        guard = readGuard({ env, configFile })
    } catch (e) {
        process.stderr.write(`magento-scripts: ${e.message}\n`)
        exit(1)
        return { status: 'refused' }
    }
    if (!guard) {
        return { status: 'no-guard' }
    }
    const [bin, ...prefix] = guard.command
    const args = (phase) => [
        ...prefix,
        phase,
        '--root',
        cwd,
        '--command',
        command,
        '--pid',
        String(process.pid)
    ]
    const result = spawnSync(bin, args('begin'), {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'inherit']
    })
    if (result.error || result.status !== 0) {
        if (result.error) {
            process.stderr.write(
                `magento-scripts: lifecycle guard from ${guard.file} could not run (${result.error.message}). ` +
                    `Refusing "${command}". Remove that file to run without the guard.\n`
            )
        } else {
            process.stderr.write(
                `magento-scripts: "${command}" refused by the lifecycle guard (${guard.file}).\n`
            )
        }
        exit(result.status || 1)
        return { status: 'refused', file: guard.file }
    }
    let interrupted = false
    onExit(() => {
        if (interrupted) {
            return
        }
        spawnSync(bin, args('end'), {
            cwd,
            env,
            stdio: ['ignore', 'ignore', 'inherit']
        })
    })
    INTERRUPT_SIGNALS.forEach((signal) =>
        onSignal(signal, () => {
            if (interrupted) {
                return
            }
            interrupted = true
            spawnSync(bin, [...args('interrupt'), '--signal', signal], {
                cwd,
                env,
                stdio: ['ignore', 'ignore', 'inherit']
            })
        })
    )
    return { status: 'admitted', file: guard.file }
}

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Runs `fn`, then lets the signal do what it would have done without us:
 * terminate the process, unless something else in CMA also listens for it.
 */
const defaultOnSignal = (signal, fn) => {
    const handler = () => {
        fn()
        process.removeListener(signal, handler)
        if (process.listenerCount(signal) === 0) {
            process.kill(process.pid, signal)
        }
    }
    process.on(signal, handler)
}

module.exports = {
    GATED_COMMANDS,
    INTERRUPT_SIGNALS,
    readGuard,
    enterLifecycleGuard
}
