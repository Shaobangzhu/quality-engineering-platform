type SuiteId = 'dgi-backend-unit' | 'dgi-frontend-unit' | 'clu-unit';

type SuiteCommand = Readonly<{
  executable: 'npm';
  args: readonly ['run', 'test:backend:unit' | 'test:frontend'] | readonly ['test'];
}>;

export type SuiteDefinition = Readonly<{
  id: SuiteId;
  repository: 'delivery-geo-intelligence' | '@shaobangzhu/clu-ui';
  command: SuiteCommand;
  requirements: Readonly<{ database: false; docker: false }>;
}>;

export const auditedCluSha = '8bda12f627e6234ed122fef29b48bd5ee2e2706d';
export const auditedDgiSha = '2ef00a81e55e7d150770bfc81abffd96dffdc0b3';

const requirements = Object.freeze({ database: false, docker: false } as const);

const catalog: readonly SuiteDefinition[] = Object.freeze([
  Object.freeze({
    id: 'dgi-backend-unit',
    repository: 'delivery-geo-intelligence',
    command: Object.freeze({ executable: 'npm', args: Object.freeze(['run', 'test:backend:unit'] as const) }),
    requirements,
  }),
  Object.freeze({
    id: 'dgi-frontend-unit',
    repository: 'delivery-geo-intelligence',
    command: Object.freeze({ executable: 'npm', args: Object.freeze(['run', 'test:frontend'] as const) }),
    requirements,
  }),
  Object.freeze({
    id: 'clu-unit',
    repository: '@shaobangzhu/clu-ui',
    command: Object.freeze({ executable: 'npm', args: Object.freeze(['test'] as const) }),
    requirements,
  }),
]);

export function findSuite(id: string): SuiteDefinition | undefined {
  return catalog.find((suite) => suite.id === id);
}
