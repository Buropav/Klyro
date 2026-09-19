FROM node:20-alpine

WORKDIR /app

# Dependency layer first so `npm ci` only re-runs when package*.json changes,
# not on every source edit.
COPY package*.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY db ./db
COPY src ./src

EXPOSE 3000

CMD ["node", "src/index.js"]
