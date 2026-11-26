import { entries, missing, type RunStorage } from './run-storage.js';
import { limitsV1 } from './result-contract-v1.js';
export type DgiLayer = 'backend' | 'frontend';
export const dgiLimits = Object.freeze({
  summaryBytes: 4096, manifestBytes: 2 * 1024 * 1024, caseBytes: 256 * 1024,
  junitBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
});
export const resultFilename = /^[a-f0-9]{64}-result\.json$/;

export class InvalidDgiEvidence extends Error {
  constructor(reason: string) { super('Invalid DGI evidence: ' + reason); }
}

export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new InvalidDgiEvidence(reason);
}

export function dgiWorkspace({ run, child, file }: Omit<RunStorage, 'verifyInventory'>, summaryBytes: number) {
  let remaining = dgiLimits.totalBytes - summaryBytes;
  function evidence(parent: number, name: string, limit: number) {
    const bytes = file(parent, name, Math.min(limit, remaining));
    remaining -= bytes.length;
    return bytes;
  }
  const workspace = child(run, 'workspace');
  return {
    batch(layer: DgiLayer) {
      check(layer === 'backend' || layer === 'frontend', 'layer');
      const results = child(child(workspace, 'artifacts'), 'allure-results');
      check(entries(results, 1).has(layer), 'mixed or missing layer');
      const scope = child(results, layer);
      check(entries(scope, 1).has('unit'), 'mixed or missing execution');
      const unit = child(scope, 'unit');
      const inventory = entries(unit, limitsV1.cases + 1);
      check(inventory.delete('dgi-manifest.json'), 'missing manifest');
      return { inventory, manifest: evidence(unit, 'dgi-manifest.json', dgiLimits.manifestBytes), readResult(name: string) {
        check(inventory.has(name) && name.length === 76 && resultFilename.test(name), 'result filename');
        return evidence(unit, name, dgiLimits.caseBytes);
      } };
    },
    junit(layer: DgiLayer) {
      check(layer === 'backend' || layer === 'frontend', 'layer');
      try {
        return evidence(child(workspace, 'reports'), layer === 'backend' ? 'backend-unit.xml' : 'frontend.xml', dgiLimits.junitBytes);
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
  };
}
