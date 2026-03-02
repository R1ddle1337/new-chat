FROM node:20-alpine

RUN corepack enable
WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @new-chat/web build

EXPOSE 3000

CMD ["pnpm", "--filter", "@new-chat/web", "start"]
