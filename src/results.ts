import { lstatSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { adaptCluJUnit } from './clu-junit.js';
import { collectDgi, dgiSummary } from './dgi-allure.js';
import { createManifestV1, limitsV1, sha256, verifyManifestV1 } from './result-contract-v1.js';
import { entries, fdPath, withRun } from './run-storage.js';
import { readSummary } from './run-summary.js';

const output = 'results-v1';
const resultName = 'result-v1.json';
const manifestName = 'manifest-v1.json';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

export function resultsCli(action: 'collect' | 'verify', runId: string) {
  return JSON.stringify(inspectResults(action, runId).manifest);
}

export function verifyResults(runId: string) {
  return inspectResults('verify', runId);
}

function inspectResults(action: 'collect' | 'verify', runId: string) {
  return withRun(runId, storage => {
    const summary = storage.file(storage.run, 'summary.json', 4096);
    const run = readSummary(summary, runId);
    const { result } = run.suiteId === 'clu-unit' ? adaptCluJUnit(storage, summary, run) : collectDgi(storage, dgiSummary(run), summary.length);
    const resultBytes = encode(result);
    const manifest = createManifestV1(resultBytes);
    const manifestBytes = encode(manifest);
    const root = fdPath(storage.run);
    for (const name of [resultName, manifestName]) {
      if (lstatSync(root + '/' + name, { throwIfNoEntry: false })) throw new Error('Conflicting historical results.');
    }
    storage.verifyInventory();
    if (action === 'collect' && !lstatSync(root + '/' + output, { throwIfNoEntry: false })) {
      // Publish both files in one rename. A competing completed directory is
      // nonempty, so rename cannot replace it. Verify the winner below.
      const stage = mkdtempSync(root + '/pending-results-');
      const stageRoot = fdPath(storage.child(storage.run, basename(stage), true));
      const staged: string[] = [];
      try {
        for (const [name, bytes] of [[resultName, resultBytes], [manifestName, manifestBytes]] as const) {
          writeFileSync(stageRoot + '/' + name, bytes, { flag: 'wx', mode: 0o600 });
          staged.push(stageRoot + '/' + name);
        }
        try {
          renameSync(stage, root + '/' + output);
          staged.length = 0;
        } catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      } finally {
        for (const path of staged) unlinkSync(path);
        if (lstatSync(stage, { throwIfNoEntry: false })) rmdirSync(stage);
      }
    }
    const directory = storage.child(storage.run, output, true);
    if (entries(directory, 2).size !== 2) throw new Error('Incomplete results.');
    const existingResult = storage.file(directory, resultName, limitsV1.resultBytes);
    const existingManifest = storage.file(directory, manifestName, limitsV1.manifestBytes);
    verifyManifestV1(existingManifest, existingResult);
    if (!resultBytes.equals(existingResult) || !manifestBytes.equals(existingManifest)) {
      throw new Error('Inconsistent historical results.');
    }
    if (action === 'verify') storage.verifyInventory();
    return { run, result, manifest, manifestSha256: sha256(existingManifest) };
  });
}
