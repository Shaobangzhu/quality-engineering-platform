# Quality Engineering Platform

QEP is a platform for federated test orchestration, cross-repository consumer testing, centralized Allure 3 reporting, and CI/CD quality gates.

INFRA-04.2 starts with a Node.js and TypeScript CLI foundation. INFRA-04.2.1 provides the project tooling and the `qe` help and version commands. QEP does not replace DGI or CLU CI yet.

## Development

Use Node.js 22.23.4 from `.nvmrc` and npm 10.9.0 or newer.

```sh
nvm install
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run qe -- help
npm run qe -- --version
```

## Planned milestones

- Continue CLI development in INFRA-04.2.2.
- Add cross-repository test orchestration, centralized reporting, and CI quality gates in subsequent phases.
