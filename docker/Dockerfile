FROM oven/bun:latest

WORKDIR /app

# Copy the application code
COPY . .

RUN bun install

# Expose the port
EXPOSE 80

# Ready to start the application
CMD ["echo", "Ready to run services"]