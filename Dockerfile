# Builds and runs the web app. The contracts are deployed separately, with
# `pnpm deploy:contracts <network>`, and their addresses are already in the repository.
FROM node:24-slim AS base
WORKDIR /app

FROM base AS build
# pnpm, in the version package.json names.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
COPY contracts/package.json contracts/
RUN pnpm install --frozen-lockfile
COPY . .

# Next.js writes NEXT_PUBLIC_ values into the pages it builds, so they are needed now.
# Everything else, secrets included, is read when the container starts.
ARG NEXT_PUBLIC_NETWORKS=local
ARG NEXT_PUBLIC_ENS=off
ENV NEXT_PUBLIC_NETWORKS=$NEXT_PUBLIC_NETWORKS NEXT_PUBLIC_ENS=$NEXT_PUBLIC_ENS
RUN pnpm build

FROM base
# The server reads the same values the pages were built with.
ARG NEXT_PUBLIC_NETWORKS=local
ARG NEXT_PUBLIC_ENS=off
ENV NEXT_PUBLIC_NETWORKS=$NEXT_PUBLIC_NETWORKS NEXT_PUBLIC_ENS=$NEXT_PUBLIC_ENS
ENV NODE_ENV=production PORT=3000
COPY --from=build /app /app
# The server runs from web/, where it keeps its data.
WORKDIR /app/web
# The file store, when no IPFS node is configured.
VOLUME /app/web/.data
EXPOSE 3000
# Started with node itself, so nothing has to be downloaded when the container starts.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
