# Use standard Node 20 alpine image
FROM node:20-alpine AS builder

# Install openssl for Prisma compatibility
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package configuration files
COPY package.json ./

# Install all dependencies (including devDependencies to compile TypeScript)
RUN npm install

# Copy source and prisma configuration files
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

# Generate Prisma Client
RUN npx prisma generate

# Compile TypeScript
RUN npm run build

# --- Production Runner Stage ---
FROM node:20-alpine

# Install openssl for Prisma compatibility and ffmpeg for audio compression
RUN apk add --no-cache openssl ffmpeg

WORKDIR /app

# Copy only package.json and install production dependencies
COPY package.json ./
RUN npm install --only=production

# Copy compiled files and generated prisma client from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma

# Create upload directory and set permission
RUN mkdir -p /app/shared_audio

# Expose API port
EXPOSE 3000

# Default command runs the API server. We will override this in docker-compose for the worker.
CMD ["npm", "run", "start"]
