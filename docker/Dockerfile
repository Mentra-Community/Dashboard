FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Clear bun cache and install dependencies
RUN bun pm cache rm && bun install --no-cache

# Copy the application code
COPY . .

# Build the application
RUN bun run build

# Expose the port
EXPOSE 80

# Ready to start the application
CMD ["echo", "Ready to run services"]
# CMD ["bun", "start"]