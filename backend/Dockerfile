# backend/Dockerfile
FROM node:24-alpine AS base

WORKDIR /app

# Copy package files
COPY package*.json ./

FROM base AS test
RUN apk add --no-cache bash
RUN npm ci
COPY . .
CMD ["npm", "test"]

FROM base AS production
# Install runtime dependencies from the lockfile.
RUN npm ci --omit=dev

# Copy application code
COPY . .

USER node

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
