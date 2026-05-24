# Use the official Bun image as your base
FROM oven/bun:latest

# Install Python 3 (required for sandbox tools)
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Copy Cloudflare's sandbox agent binary from the official image
COPY --from=docker.io/cloudflare/sandbox:latest /container-server/sandbox /sandbox

# Set up your app or scripts
WORKDIR /workspace

# The sandbox binary must be your entrypoint so Cloudflare can communicate with it
ENTRYPOINT ["/sandbox"]
