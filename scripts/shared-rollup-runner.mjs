import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRollupBin = resolve(root, 'node_modules/rollup/dist/bin/rollup');
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export class RollupRunnerError extends Error {
  constructor(kind, message, result, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RollupRunnerError';
    this.kind = kind;
    this.result = result;
  }
}

/**
 * Runs one Rollup process and recognizes completion from exact Rollup output paths.
 *
 * Large TypeScript bundles can leave @rollup/plugin-typescript's watch program
 * holding FSWatcher/StatWatcher handles after writeBundle. Keeping Rollup in an
 * isolated process lets us preserve its real exit status while bounding those
 * known legacy handles after every expected output has been written.
 */
export async function runRollupOnce(options) {
  const expectedOutputs = normalizeExpectedOutputs(options.expectedOutputs);
  const markerPatterns = expectedOutputs.map(output => ({
    output,
    pattern: new RegExp(`(?:^|\\n)created\\s+${escapeRegExp(output)}(?=\\s+in(?:\\s|$))`, 'i'),
  }));
  const timeoutMs = positiveDuration(options.timeoutMs, 120_000, 'timeoutMs');
  const exitGraceMs = nonNegativeDuration(options.exitGraceMs, 1_500, 'exitGraceMs');
  const terminateGraceMs = positiveDuration(options.terminateGraceMs, 1_000, 'terminateGraceMs');
  const killGraceMs = positiveDuration(options.killGraceMs, 1_000, 'killGraceMs');
  const label = options.label ?? expectedOutputs.join(', ');
  const command = options.command ?? process.execPath;
  const args = options.args ?? [
    '--max-old-space-size=2048',
    options.rollupBin ?? defaultRollupBin,
    '-c',
    options.config ?? 'rollup.config.js',
  ];
  const logger = options.logger ?? console;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const detached = options.detached ?? process.platform !== 'win32';
  const startedAt = Date.now();
  const observedOutputs = new Set();
  let scanBuffer = '';
  let markersCompletedAt = null;
  let termination = 'none';
  let timedOutBeforeMarker = false;
  let closed = false;
  let spawnError = null;
  let exitCode = null;
  let exitSignal = null;
  let timeoutTimer = null;
  let exitGraceTimer = null;
  let terminateTimer = null;
  let killTimer = null;

  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });

  const completion = new Promise(resolveCompletion => {
    const handleOutput = (chunk, destination) => {
      destination?.write?.(chunk);
      scanBuffer = stripAnsi(`${scanBuffer}${chunk.toString()}`).slice(-131_072);
      for (const marker of markerPatterns) {
        if (!observedOutputs.has(marker.output) && marker.pattern.test(scanBuffer)) {
          observedOutputs.add(marker.output);
        }
      }
      if (observedOutputs.size === expectedOutputs.length && markersCompletedAt === null) {
        markersCompletedAt = Date.now();
        clearTimer(timeoutTimer);
        exitGraceTimer = setTimeout(() => {
          if (closed) return;
          termination = 'sigterm';
          logger.warn?.(
            `[rollup-runner] ${label} produced ${expectedOutputs.join(', ')} but retained process handles `
            + `for ${exitGraceMs}ms; sending SIGTERM to process group ${child.pid ?? 'unknown'}.`,
          );
          signalProcessTree(child, 'SIGTERM', detached);
          terminateTimer = setTimeout(() => {
            if (closed) return;
            termination = 'sigkill';
            logger.warn?.(
              `[rollup-runner] ${label} ignored SIGTERM for ${terminateGraceMs}ms; sending SIGKILL.`,
            );
            signalProcessTree(child, 'SIGKILL', detached);
            killTimer = setTimeout(() => resolveCompletion(), killGraceMs);
          }, terminateGraceMs);
        }, exitGraceMs);
      }
    };

    child.stdout?.on('data', chunk => handleOutput(chunk, stdout));
    child.stderr?.on('data', chunk => handleOutput(chunk, stderr));
    child.once('error', error => {
      spawnError = error;
      resolveCompletion();
    });
    child.once('close', (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      resolveCompletion();
    });

    timeoutTimer = setTimeout(() => {
      if (closed || markersCompletedAt !== null) return;
      timedOutBeforeMarker = true;
      termination = 'sigterm';
      logger.error?.(
        `[rollup-runner] Timed out after ${timeoutMs}ms before ${label} produced `
        + `${expectedOutputs.join(', ')}; sending SIGTERM.`,
      );
      signalProcessTree(child, 'SIGTERM', detached);
      terminateTimer = setTimeout(() => {
        if (closed) return;
        termination = 'sigkill';
        logger.warn?.(
          `[rollup-runner] ${label} ignored timeout SIGTERM for ${terminateGraceMs}ms; sending SIGKILL.`,
        );
        signalProcessTree(child, 'SIGKILL', detached);
        killTimer = setTimeout(() => resolveCompletion(), killGraceMs);
      }, terminateGraceMs);
    }, timeoutMs);
  });

  await completion;
  clearTimer(timeoutTimer);
  clearTimer(exitGraceTimer);
  clearTimer(terminateTimer);
  clearTimer(killTimer);

  const result = Object.freeze({
    label,
    expectedOutputs: Object.freeze([...expectedOutputs]),
    observedOutputs: Object.freeze([...observedOutputs]),
    markersComplete: observedOutputs.size === expectedOutputs.length,
    lingeringHandles: markersCompletedAt !== null && termination !== 'none',
    termination,
    exitCode,
    exitSignal,
    pid: child.pid ?? null,
    elapsedMs: Date.now() - startedAt,
  });

  if (spawnError) {
    throw new RollupRunnerError('spawn-error', `Failed to start Rollup for ${label}: ${spawnError.message}`, result, spawnError);
  }
  if (timedOutBeforeMarker) {
    throw new RollupRunnerError(
      'marker-timeout',
      `Rollup ${label} timed out before producing ${missingOutputs(expectedOutputs, observedOutputs).join(', ')}.`,
      result,
    );
  }
  if (!closed) {
    throw new RollupRunnerError(
      'termination-timeout',
      `Rollup ${label} did not close after bounded SIGTERM/SIGKILL escalation.`,
      result,
    );
  }
  if (exitCode !== null && exitCode !== 0) {
    throw new RollupRunnerError(
      'nonzero-exit',
      `Rollup ${label} exited with code ${exitCode}${result.markersComplete ? ' after producing its expected output' : ''}.`,
      result,
    );
  }
  if (!result.markersComplete) {
    throw new RollupRunnerError(
      'missing-marker',
      `Rollup ${label} exited before producing ${missingOutputs(expectedOutputs, observedOutputs).join(', ')}.`,
      result,
    );
  }
  if (exitCode === null && termination === 'none') {
    throw new RollupRunnerError(
      'unexpected-signal',
      `Rollup ${label} was terminated by ${exitSignal ?? 'an unknown signal'} before the runner requested shutdown.`,
      result,
    );
  }
  return result;
}

function normalizeExpectedOutputs(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('runRollupOnce expectedOutputs must be a non-empty array.');
  }
  const outputs = value.map(output => String(output).trim().replaceAll('\\', '/'));
  if (outputs.some(output => output.length === 0)) {
    throw new TypeError('runRollupOnce expectedOutputs must not contain empty paths.');
  }
  return [...new Set(outputs)];
}

function signalProcessTree(child, signal, detached) {
  if (!child.pid) return false;
  try {
    if (detached && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, '').replaceAll('\r', '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function missingOutputs(expected, observed) {
  return expected.filter(output => !observed.has(output));
}

function positiveDuration(value, fallback, label) {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError(`${label} must be greater than zero.`);
  return Math.floor(duration);
}

function nonNegativeDuration(value, fallback, label) {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`${label} must be zero or greater.`);
  return Math.floor(duration);
}

function clearTimer(timer) {
  if (timer !== null) clearTimeout(timer);
}
