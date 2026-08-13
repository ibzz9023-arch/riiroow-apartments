# multi-stage Dockerfile for building TypeScript app

# Build stage
FROM node:18 AS builder
WORKDIR /app

# Install all dependencies (including dev) for build
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci

COPY backend/ .
RUN npm run build

# Production image
FROM node:18-alpine
WORKDIR /app

# Install only production dependencies
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --production

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 4000
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
