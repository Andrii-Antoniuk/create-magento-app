const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { enterLifecycleGuard, readGuard } = require('./lifecycle-guard')

const dir = fs.mkdtempSync(
    path.join(process.env.LIFECYCLE_GUARD_TEST_TMP || os.tmpdir(), 'cma-guard-')
)
const log = path.join(dir, 'calls.log')
const guardScript = path.join(dir, 'guard.js')
fs.writeFileSync(
    guardScript,
    `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
if (process.env.GUARD_REFUSE && process.argv[2] === 'begin') { process.stderr.write('busy\\n'); process.exit(2) }
`
)
const configFile = path.join(dir, 'lifecycle-guard.json')
const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
const run = (command, env = {}) => {
    const exits = []
    const hooks = []
    const signals = {}
    const r = enterLifecycleGuard(command, {
        cwd: dir,
        env: { ...process.env, ...env },
        configFile,
        exit: (code) => exits.push(code),
        onExit: (fn) => hooks.push(fn),
        onSignal: (signal, fn) => {
            signals[signal] = fn
        }
    })
    return { r, exits, hooks, signals }
}

try {
    // No guard installed: everything runs as before.
    assert.strictEqual(readGuard({ env: {}, configFile }), null)
    assert.strictEqual(run('start').r.status, 'no-guard')

    fs.writeFileSync(
        configFile,
        JSON.stringify({ command: [process.execPath, guardScript] })
    )

    // Read-only commands never ask.
    assert.strictEqual(run('status').r.status, 'not-gated')
    assert.strictEqual(run('exec').r.status, 'not-gated')
    assert.deepStrictEqual(calls(), [])

    // Admitted: begin now, end on exit, both naming this process.
    const admitted = run('stop')
    assert.strictEqual(admitted.r.status, 'admitted')
    assert.deepStrictEqual(admitted.exits, [])
    admitted.hooks.forEach((fn) => fn())
    assert.deepStrictEqual(calls(), [
        `begin --root ${dir} --command stop --pid ${process.pid}`,
        `end --root ${dir} --command stop --pid ${process.pid}`
    ])

    // Interrupted: calls interrupt, never end, even when exit fires later.
    fs.rmSync(log)
    const killed = run('start')
    assert.deepStrictEqual(Object.keys(killed.signals).sort(), [
        'SIGHUP',
        'SIGINT',
        'SIGTERM'
    ])
    killed.signals.SIGTERM()
    killed.signals.SIGINT()
    killed.hooks.forEach((fn) => fn())
    assert.deepStrictEqual(calls(), [
        `begin --root ${dir} --command start --pid ${process.pid}`,
        `interrupt --root ${dir} --command start --pid ${process.pid} --signal SIGTERM`
    ])

    // Refused: exits with the guard's status, never registers end.
    const refused = run('import-db', { GUARD_REFUSE: '1' })
    assert.strictEqual(refused.r.status, 'refused')
    assert.deepStrictEqual(refused.exits, [2])
    assert.deepStrictEqual(refused.hooks, [])

    // A guard that cannot run, or a broken file, fails closed.
    fs.writeFileSync(
        configFile,
        JSON.stringify({ command: [path.join(dir, 'missing-binary')] })
    )
    assert.deepStrictEqual(run('cleanup').exits, [1])
    fs.writeFileSync(configFile, '{ not json')
    assert.deepStrictEqual(run('start').exits, [1])
    // An explicitly named guard file that is missing fails closed too.
    assert.deepStrictEqual(
        run('start', { CMA_LIFECYCLE_GUARD: path.join(dir, 'nope.json') })
            .exits,
        [1]
    )
} finally {
    fs.rmSync(dir, { recursive: true, force: true })
}
console.log('lifecycle-guard tests passed')
