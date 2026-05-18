FROM alpine:latest

# Install python, nodejs, and other common utilities
RUN apk add --no-cache python3 py3-pip nodejs npm bash curl

# Set up a working directory
WORKDIR /home/sandbox

# Default command
CMD ["/bin/bash"]
