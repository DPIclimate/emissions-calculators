// @ts-check

import {
  constants, copyFileSync, mkdirSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import {
  calculateEmissions,
  isValidCalculatorName,
} from './packages/calculators/dist/index.mjs';

/**
 * @typedef {import('./packages/calculators/dist/index.d.ts').CalculatorNames} CalculatorName
 * @typedef {'--scan' | '--watch'} DirectoryMode
 * @typedef {'OK' | 'INVALID_INPUT' | 'ERROR'} ResultStatus
 * @typedef {{status: 'ERROR', message: string}} CalculationError
 * @typedef {Exclude<ReturnType<typeof calculateEmissions>, {status: 'ERROR'}> | CalculationError} CalculationResult
 *
 * @typedef {object} DirectoryOptions
 * @property {string} inputRoot
 * @property {string} outputRoot
 * @property {string} doneRoot
 * @property {number} workers
 * @property {string} timezone
 *
 * @typedef {object} FileJob
 * @property {CalculatorName} calculator
 * @property {string} inputFile
 * @property {string} outputFile
 * @property {string} relativeFile
 * @property {string} doneRoot
 * @property {string} timezone
 *
 * @typedef {object} JobResult
 * @property {ResultStatus} status
 * @property {string} inputFile
 * @property {string} [outputFile]
 * @property {string} [doneFile]
 * @property {string} [message]
 *
 * @typedef {Worker & {failure: Error | null}} CalculatorWorker
 */

/**
 * Parse an input document and return a JSON-safe calculator result.
 * @param {CalculatorName} calculator
 * @param {string} text
 * @returns {CalculationResult}
 */
function calculate(calculator, text) {
  try {
    const result = calculateEmissions(calculator, JSON.parse(text), {
      disableMetrics: true,
    });
    return result.status === 'ERROR'
      ? { status: 'ERROR', message: result.error.message }
      : result;
  } catch (error) {
    return { status: 'ERROR', message: error.message };
  }
}

/**
 * Save a result before archiving its input, including across mounted filesystems.
 * @param {FileJob} job
 * @returns {JobResult}
 */
function processFile(job) {
  const { calculator, inputFile, outputFile, doneRoot, relativeFile, timezone } = job;
  const text = readFileSync(inputFile, 'utf8');
  const output = calculate(calculator, text);
  // Producers must publish complete files using rename, and not replace pending files.
  if (readFileSync(inputFile, 'utf8') !== text) {
    throw new Error('Input changed during calculation; leaving it for the next scan.');
  }
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(`${outputFile}.tmp`, `${JSON.stringify(output)}\n`);
  renameSync(`${outputFile}.tmp`, outputFile);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const date = ['year', 'month', 'day']
    .map(type => parts.find(part => part.type === type).value).join('-');
  let doneFile = join(doneRoot, calculator, date, relativeFile);
  mkdirSync(dirname(doneFile), { recursive: true });
  try {
    copyFileSync(inputFile, doneFile, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    doneFile = `${doneFile.slice(0, -5)}.${randomUUID()}.json`;
    copyFileSync(inputFile, doneFile, constants.COPYFILE_EXCL);
  }
  // Copy then unlink works when /inputs and /done are separate mounts.
  unlinkSync(inputFile);
  return { status: output.status, inputFile, outputFile, doneFile };
}

/**
 * Collect regular JSON files recursively without following symbolic links.
 * @param {CalculatorName} calculator
 * @param {string} directory
 * @param {string} relativeDirectory
 * @param {DirectoryOptions} options
 * @param {FileJob[]} jobs
 * @returns {void}
 */
function collectJobs(calculator, directory, relativeDirectory, options, jobs) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const inputFile = join(directory, entry.name);
    const relativeFile = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      collectJobs(calculator, inputFile, relativeFile, options, jobs);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      jobs.push({
        calculator, inputFile, relativeFile,
        outputFile: join(options.outputRoot, calculator, relativeFile),
        doneRoot: options.doneRoot, timezone: options.timezone,
      });
    }
  }
}

/**
 * Send one job to a worker and propagate crashes rather than hanging the queue.
 * @param {CalculatorWorker} worker
 * @param {FileJob} job
 * @returns {Promise<JobResult>}
 */
function runJob(worker, job) {
  return new Promise((resolveJob, rejectJob) => {
    /**
     * Remove the listeners belonging to this job once it finishes.
     * @returns {void}
     */
    function cleanup() {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }
    /**
     * Resolve a completed job, including file-level error results.
     * @param {JobResult} result
     * @returns {void}
     */
    function onMessage(result) {
      cleanup();
      resolveJob(result);
    }
    /**
     * Reject the job if its worker crashes.
     * @param {Error} error
     * @returns {void}
     */
    function onError(error) {
      cleanup();
      rejectJob(error);
    }
    /**
     * Reject an unexpected exit, even if its exit code is zero.
     * @param {number} code
     * @returns {void}
     */
    function onExit(code) {
      onError(new Error(`Calculator worker exited unexpectedly (${code}).`));
    }
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.postMessage(job);
  });
}

/**
 * Scan in bounded parallel batches using a persistent pool of calculator workers.
 * @param {DirectoryMode} mode
 * @param {DirectoryOptions} options
 * @returns {Promise<void>}
 */
async function runDirectoryMode(mode, options) {
  const roots = [options.inputRoot, options.outputRoot, options.doneRoot].map(resolvePath => resolve(resolvePath));
  if (roots.some((root, index) => roots.some((other, otherIndex) =>
    index !== otherIndex && (root === other || root.startsWith(`${other}/`))))) {
    throw new Error('Input, output and done roots must be separate directory trees.');
  }
  // Fail early on an invalid timezone, before any inputs are processed.
  new Intl.DateTimeFormat('en-CA', { timeZone: options.timezone }).format();
  /** @type {CalculatorWorker[]} */
  const workers = [];
  let stopping = false;
  /**
   * Stop accepting jobs while allowing active jobs to finish.
   * @returns {void}
   */
  function stop() { stopping = true; }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    for (let index = 0; index < options.workers; index += 1) {
      const worker = /** @type {CalculatorWorker} */ (
        new Worker(new URL(import.meta.url))
      );
      // Retain idle/startup failures so they cannot become unhandled events.
      worker.failure = null;
      worker.on('error', error => { worker.failure = /** @type {Error} */ (error); });
      worker.on('exit', code => {
        worker.failure ??= new Error(`Calculator worker exited (${code}).`);
      });
      workers.push(worker);
    }
    do {
      let failed = false;
      /** @type {FileJob[]} */
      const jobs = [];
      for (const entry of readdirSync(options.inputRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!isValidCalculatorName(entry.name)) {
          console.error(`Unknown calculator directory: ${entry.name}`);
          failed = true;
          continue;
        }
        collectJobs(entry.name, join(options.inputRoot, entry.name), '', options, jobs);
      }
      let nextJob = 0;
      await Promise.all(workers.map(async worker => {
        while (!stopping && nextJob < jobs.length) {
          if (worker.failure) {
            throw worker.failure;
          }
          const job = jobs[nextJob++];
          const result = await runJob(worker, job);
          failed = result.status !== 'OK' || failed;
          console.error(result.message
            ? `${result.inputFile}: ${result.message}`
            : `${result.status}: ${result.inputFile} -> ${result.outputFile}; archived ${result.doneFile}`);
        }
      }));
      if (mode === '--scan') {
        process.exitCode = failed ? 1 : 0;
        break;
      }
      if (!stopping) {
        await delay(2000);
      }
    } while (!stopping);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

/**
 * Parse command-line options and preserve the original one-shot interface.
 * @returns {Promise<void>}
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  node calculate.mjs CALCULATOR INPUT.json
  node calculate.mjs --scan [INPUT_ROOT OUTPUT_ROOT [DONE_ROOT]] [OPTIONS]
  node calculate.mjs --watch [INPUT_ROOT OUTPUT_ROOT [DONE_ROOT]] [OPTIONS]

CALCULATOR  Calculator name, for example cotton, grains, or beef.
INPUT.json  One-shot mode prints the result to stdout and leaves the input alone.
--scan      Process the directory tree once; exit nonzero on any failure.
--watch     Scan immediately and after each batch, with a 2-second pause.
--workers N Parallel calculator threads in directory modes (default 2).
--timezone ZONE  Archive date timezone (default TZ, otherwise Australia/Sydney).
INPUT_ROOT  Default /inputs; first-level directories name calculators.
OUTPUT_ROOT Default /outputs; preserve calculator and nested paths.
DONE_ROOT   Default /done; archive under CALCULATOR/yyyy-mm-dd/nested/path.json.

Outputs are written as .json.tmp then renamed to .json. Inputs are archived
only after output publication, including INVALID_INPUT and ERROR results.
Existing archived files are preserved; name collisions get a UUID suffix.
File read/write/archive failures leave inputs available for retry.
Only regular .json files are read; symbolic links are ignored.
Publish complete inputs by renaming .tmp to .json; do not replace pending files.
Run only one scanner for a given set of directories. Shutdown drains active jobs.
`);
    return;
  }
  const mode = args.shift();
  if (mode === '--scan' || mode === '--watch') {
    /** @type {DirectoryOptions} */
    const options = {
      inputRoot: '/inputs', outputRoot: '/outputs', doneRoot: '/done',
      workers: 2, timezone: process.env.TZ || 'Australia/Sydney',
    };
    /** @type {string[]} */
    const directories = [];
    while (args.length) {
      const argument = args.shift();
      if (argument === '--workers') {
        options.workers = Number(args.shift());
        if (!Number.isInteger(options.workers) || options.workers < 1) {
          throw new Error('--workers requires a positive integer.');
        }
      } else if (argument === '--timezone') {
        options.timezone = args.shift();
        if (!options.timezone) {
          throw new Error('--timezone requires a timezone name.');
        }
      } else if (argument.startsWith('-')) {
        throw new Error(`Unknown option: ${argument}`);
      } else {
        directories.push(argument);
      }
    }
    if (directories.length !== 0 && directories.length !== 2 && directories.length !== 3) {
      throw new Error('Supply INPUT_ROOT OUTPUT_ROOT [DONE_ROOT], or no roots.');
    }
    if (directories.length) {
      [options.inputRoot, options.outputRoot] = directories;
      options.doneRoot = directories[2] ?? '/done';
    }
    await runDirectoryMode(mode, options);
  } else {
    const [inputFile] = args;
    if (args.length !== 1 || !isValidCalculatorName(mode)) {
      throw new Error('Supply a valid calculator and input file. Use --help.');
    }
    const output = calculate(mode, readFileSync(inputFile, 'utf8'));
    console.log(JSON.stringify(output));
    process.exitCode = output.status === 'OK' ? 0 : 1;
  }
}

if (isMainThread) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'ERROR', message: error.message }));
    process.exitCode = 1;
  });
} else {
  parentPort.on('message', /** @param {FileJob} job */ job => {
    try {
      parentPort.postMessage(processFile(job));
    } catch (error) {
      parentPort.postMessage({ status: 'ERROR', inputFile: job.inputFile, message: error.message });
    }
  });
}
