# Self-hosted Edgegap MCP server over Streamable HTTP (src/http.ts).
#
#   docker build -t edgegap-mcp .
#   docker run --rm -p 8080:8080 edgegap-mcp
#
# Clients send their own Edgegap token as an Authorization header on every
# request. The image holds no credential; do not add one.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/http.js"]
