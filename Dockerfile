# syntax=docker/dockerfile:1

# Build stage: install the whole workspace, compile every artifact (native
# system binaries, Host/Client libraries, Web frontend), then stage the tree
# without node_modules for the runtime image.
FROM node:24-bookworm-slim AS build

# musl-tools builds the static landlock-run launcher; python3/make/g++ cover
# dependency install scripts that have no matching prebuild.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git musl-tools python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@11.28.5

WORKDIR /app
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm run build:artifacts

# build:artifacts builds only the Node-API flock addon; the Landlock launcher
# the Linux sandbox falls back to is a separate static-musl target.
RUN pnpm --filter @deepseek-ai/node-addon-system-workspace run build:native

RUN mkdir -p /staged \
 && tar -cf - --exclude=node_modules --exclude=.git --exclude='*.tsbuildinfo' . | tar -xf - -C /staged

# Runtime stage: production dependencies only; the built tree is copied from
# the build stage, so no compiler is needed here.
FROM node:24-bookworm-slim AS runtime

# git serves agent commands and git-hosted plugin installs; pnpm serves the
# plugin manager, which shells out to it from PATH.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@11.28.5

ENV DSH_HOME=/data
WORKDIR /app
COPY --from=build /staged/ /app/

# The workspace satisfies peer dependencies with matching devDependencies, so a
# production install drops every one of them. Promote each declared peer to a
# root dependency, the flat layout an npm install of the published packages
# produces, so packages under /app/packages resolve them by walking up to
# /app/node_modules.
RUN node --input-type=commonjs <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const manifestPath = 'package.json'
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const peers = new Map()
const skip = new Set(['node_modules', 'lib', 'dist', 'src', 'tests', 'test', 'scripts'])

function visit(directory, depth) {
  if (depth > 4) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue
    const child = path.join(directory, entry.name)
    const childManifest = path.join(child, 'package.json')
    if (fs.existsSync(childManifest)) {
      const parsed = JSON.parse(fs.readFileSync(childManifest, 'utf8'))
      for (const [name, spec] of Object.entries(parsed.peerDependencies ?? {})) {
        const previous = peers.get(name)
        if (previous === undefined || (!previous.startsWith('workspace:') && spec.startsWith('workspace:'))) {
          peers.set(name, spec)
        }
      }
    }
    visit(child, depth + 1)
  }
}

for (const directory of ['packages', 'vendor', 'apps', 'native', 'website', 'benchmarks', 'python']) {
  if (fs.existsSync(directory)) visit(directory, 0)
}

manifest.dependencies ??= {}
for (const [name, spec] of peers) {
  manifest.dependencies[name] = spec
  delete manifest.devDependencies?.[name]
  delete manifest.optionalDependencies?.[name]
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`promoted ${peers.size} peer dependencies to root dependencies`)
EOF

# The root postinstall imports lefthook at module load; lefthook is a
# devDependency a production install does not carry, so scripts are skipped
# here and the two runtime packages that need them are rebuilt explicitly.
# --no-frozen-lockfile is required because the promoted peers were not in the
# root manifest when the lockfile was written.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --no-frozen-lockfile --ignore-scripts \
 && pnpm rebuild koffi @deepseek-ai/dsh-subprocess-local

RUN ln -s /app/apps/cli/lib/bin.js /usr/local/bin/dsh \
 && mkdir -p /data /workspace \
 && chown node:node /data /workspace

USER node
WORKDIR /workspace
EXPOSE 3080

CMD ["dsh", "web", "--host", "0.0.0.0", "--allow-wildcard-host", "--no-open", "--port", "3080"]
