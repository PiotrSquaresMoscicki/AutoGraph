# Development stage - used by devcontainer
FROM node:22-bookworm AS development

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose Vite dev server port
EXPOSE 5173

# Default command for development
CMD ["npm", "run", "dev", "--", "--host"]

# Build stage - builds the static assets
FROM node:22-bookworm AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (npm ci for faster, reproducible builds)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage - serves static files with nginx
FROM nginx:alpine AS production

# Copy built static files to nginx html directory
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# nginx runs automatically as the default command
CMD ["nginx", "-g", "daemon off;"]
