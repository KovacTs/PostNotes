# --- Stage 1: Build React Frontend ---
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Build Backend ---
FROM node:20-alpine AS backend-builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/prisma ./prisma/
COPY backend/src ./src/
RUN npx prisma generate
RUN npm run build

# --- Stage 3: Production Runner Stage ---
FROM node:20-alpine

# Install openssl for Prisma compatibility and ffmpeg for audio compression
RUN apk add --no-cache openssl ffmpeg

WORKDIR /app

# Copy package configuration and install production-only dependencies
COPY backend/package*.json ./
RUN npm install --only=production

# Copy compiled backend files and generated prisma client
COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-builder /app/prisma ./prisma

# Copy compiled static frontend assets (Express will serve these from /frontend/dist)
COPY --from=frontend-builder /frontend/dist /frontend/dist

# Create upload directory and set permission
RUN mkdir -p /app/shared_audio

# Expose API port
EXPOSE 3000

# Default command runs the API server. We override this in docker-compose for the worker.
CMD ["npm", "run", "start"]
