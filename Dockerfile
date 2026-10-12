FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json server.mjs ./
RUN npm ci --omit=dev
COPY dist ./dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

USER node
CMD ["node", "server.mjs"]
