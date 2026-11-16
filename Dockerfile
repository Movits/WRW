# Imagem de produção da WRW. Vale para Railway, Render, Fly.io ou qualquer
# host que rode container. O app é um processo Node único: serve a API tRPC
# em /api/trpc e o front-end compilado na mesma origem.

FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node_modules vem inteiro do estágio de build, sem um segundo install.
#
# Não use `pnpm install --prod` aqui. O bundle do servidor é gerado com
# esbuild --packages=external, e server/_core/index.ts importa ./vite de
# forma estática para o modo de desenvolvimento. O resultado é que
# dist/index.js carrega no topo `vite`, `@vitejs/plugin-react` e
# `@tailwindcss/vite`, todos devDependencies. Numa instalação só de produção
# o processo morre no boot com ERR_MODULE_NOT_FOUND, antes de atender a
# primeira requisição.
#
# Isso deixa a imagem maior que o necessário. A correção de verdade é separar
# serveStatic de setupVite e carregar o Vite por import dinâmico só em
# desenvolvimento. Está registrado em docs/deploy.md.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# O boot aplica as migrações pendentes (scripts/migrar.mjs) antes de aceitar
# tráfego — o script e a pasta drizzle/ precisam existir na imagem final.
COPY --from=build /app/scripts ./scripts

EXPOSE 3000
CMD ["node", "dist/index.js"]
