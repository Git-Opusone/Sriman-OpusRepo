# Use the official Playwright image — it includes all Chromium system dependencies
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Set working directory
WORKDIR /app

# Copy package files first (layer caching — only reinstalls deps if package.json changes)
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Copy application source
COPY . .

# Remove dev files not needed in production
RUN rm -rf .env.example scripts .vscode .claude

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser
# Agent state dir — mounted as the named volume "opus-agent-data", which takes
# this directory's ownership on first creation
RUN mkdir -p /app/agent-data
RUN chown -R appuser:appuser /app
USER appuser

# Expose the app port
EXPOSE 3000

# Health check — AWS uses this to know if container is healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

# Start the server
CMD ["node", "server.js"]
