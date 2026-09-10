# Northflank's buildpack build should auto-detect this Node app without
# needing this file at all (see README.md's "Deploying (Northflank)"
# section) - this is the documented fallback for when buildpack detection
# doesn't work, and an option if you'd rather have explicit control.
FROM node:18-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
