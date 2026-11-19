# Quality Engineering Platform

QEP is a platform for federated test orchestration, cross-repository consumer testing, centralized Allure 3 reporting, and CI/CD quality gates.

INFRA-04.2.1 provides the Node.js and TypeScript CLI foundation. INFRA-04.2.2 adds a suite catalog and read-only planning.

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

## Plan a suite

Build QEP first. Use the built `qe` executable on your PATH or invoke it with `node dist/cli.js`.

```sh
qe plan --suite dgi-backend-unit --source "$SOURCE_PATH" --sha "$SOURCE_SHA"
qe plan --suite clu-unit --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
```

Supply an absolute source checkout path and its full, 40-character Git HEAD SHA.

| Suite | Source `package.json` name | Planned command |
| --- | --- | --- |
| `dgi-backend-unit` | `delivery-geo-intelligence` | `npm run test:backend:unit` |
| `dgi-frontend-unit` | `delivery-geo-intelligence` | `npm run test:frontend` |
| `clu-unit` | `@shaobangzhu/clu-ui` | `npm test` |

The plan identifies an isolated workspace and an artifact destination under the QEP root. Both paths contain a `<run-id>` placeholder for a future run. All three profiles declare zero database and Docker requirements. Planning prints these details and checks the source using Git and package metadata. The JSON command object has separate `executable` and `args` fields. Invalid input produces a diagnostic on stderr and exits with code 2.

Planning supports local SHA-1 Git checkouts with a `.git` directory, a regular source `package.json`, and a Git executable that supports `--no-lazy-fetch`. It rejects linked and sparse worktrees, submodules, and Git configuration includes. An ordinary Git checkout with stale index timestamps can be rejected even when the tracked bytes match. The planner checks the installed npm package metadata through the standard `bin/npm-cli.js` launcher and validates Node and npm against QEP's requirements and any corresponding source `engines` ranges.
