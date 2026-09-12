# Prepare the pinned fork with pnpm runtime:fetch && pnpm build before building this image.
FROM node:24-bookworm-slim AS build
RUN npm install -g pnpm@11.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/scripts/admin-token.mjs ./scripts/admin-token.mjs
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/runtime/public/manifest.json ./runtime/public/manifest.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4180 4181
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4180/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
