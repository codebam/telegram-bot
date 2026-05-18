FROM alpine:latest

# Install python and other common utilities
RUN apk add --no-base --no-cache python3 py3-pip bash curl

# Set up a working directory
WORKDIR /home/sandbox

# Default command
CMD ["/bin/bash"]
