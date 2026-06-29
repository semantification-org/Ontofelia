FROM node:22-slim

RUN groupadd -r sandbox && useradd -r -g sandbox -m sandbox

# Base tools for code execution
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    python3-pip \
    jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
USER sandbox

CMD ["sleep", "infinity"]
