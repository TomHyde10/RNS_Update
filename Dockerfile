# Northflank's buildpack should detect this Node app without needing this
# file. It is the documented fallback, and what to use if you would rather
# have explicit control over the build.
FROM node:18-alpine
WORKDIR /app

# No runtime dependencies: package.json exists for scripts and engines. The
# zip/xlsx handling the curve needs is implemented in lib/zip.js precisely so
# this image needs neither an npm install nor an `apk add unzip`.
COPY package*.json ./
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
