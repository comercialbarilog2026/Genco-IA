FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/genco-ia.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
