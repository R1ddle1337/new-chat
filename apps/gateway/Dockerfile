FROM node:20-alpine

RUN corepack enable
WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @new-chat/gateway build

EXPOSE 3001

CMD ["pnpm", "--filter", "@new-chat/gateway", "start"]
